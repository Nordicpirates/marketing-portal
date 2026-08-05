// Page behaviour for /lp/aboard.
//
// The form posts to /lp/aboard/claim and the answer decides which of the result
// states gets rendered into #result. Cart links are built here, in the browser,
// from the offer and edition the visitor chose plus the code the endpoint sent
// back. The codes are never written into this file or the HTML - they rotate.

import { buildCartUrl } from "./offer.js";

const form = document.getElementById("giftform");
const result = document.getElementById("result");
const submitBtn = document.getElementById("submit-btn");
const emailInput = document.getElementById("email");

/** The offer + edition a given state actually puts in the cart. */
function targetFor(state, offer, edition) {
  // Blocked means we will not ship what they picked, so the state offers the BIG BOX
  // in the same edition instead. Its code is the one the endpoint sent back.
  if (state === "blocked") return { offer: "bigbox-both", edition };
  return { offer, edition };
}

// One state serves all three offers, so the cart button has to say what it is really
// loading. A BIG BOX cart is three items, not "the game and the gift". The blocked
// state names the BIG BOX in its own markup and needs no swap.
const CART_COPY = {
  "bigbox-both": {
    label: "Put the BIG BOX and both gifts in my cart",
    note: "One click loads all three items.",
  },
};

function chosen(name) {
  const el = form.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : "";
}

function showError(message) {
  render("error", { message });
}

/** Swap #result for one of the <template> states. */
function render(kind, data) {
  const tpl = document.getElementById(`tpl-${kind}`);
  if (!tpl) {
    console.error(`[lp/aboard] no template for state "${kind}"`);
    result.textContent = "Something went wrong on our side. Please try again.";
    return;
  }

  const node = tpl.content.cloneNode(true);

  const message = node.querySelector("[data-message]");
  if (message) message.textContent = data.message || "";

  const codeEl = node.querySelector("[data-code]");
  if (codeEl) codeEl.textContent = data.code || "";

  const copyFor = CART_COPY[data.offer];
  if (copyFor) {
    const note = node.querySelector("[data-cart-note]");
    if (note) note.textContent = copyFor.note;
  }

  const cart = node.querySelector("[data-cart]");
  if (cart) {
    if (copyFor) cart.textContent = copyFor.label;
    if (data.cartUrl) {
      cart.href = data.cartUrl;
    } else {
      // No link is better than a broken one, but somebody needs to know.
      console.error(`[lp/aboard] no cart url for state "${kind}", hiding the cart button`);
      cart.remove();
    }
  }

  const copy = node.querySelector("[data-copy]");
  if (copy && data.code) {
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(data.code);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 2000);
      } catch (err) {
        // Clipboard is blocked on insecure origins and by some browsers. The code
        // is on screen either way, so say so rather than failing silently.
        console.warn("[lp/aboard] clipboard write refused:", err);
        copy.textContent = "Select it";
      }
    });
  }

  result.replaceChildren(node);
  result.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// No "action" is ever sent. The endpoint refuses one, because a form post proves
// nothing about who owns the address in it and must not carry an instruction about
// somebody's mailing list. Re-subscribing needs a confirmed-email flow, not this.
async function submit() {
  const offer = chosen("offer");
  const edition = chosen("edition");
  const email = (emailInput.value || "").trim();

  const honeypot = form.querySelector('input[name="company"]');
  if (!honeypot) console.error("[lp/aboard] honeypot field is missing from the form");
  const company = honeypot ? (honeypot.value || "").trim() : "";

  if (!emailInput.checkValidity()) {
    emailInput.reportValidity();
    return;
  }

  submitBtn.setAttribute("aria-busy", "true");
  submitBtn.disabled = true;

  try {
    const res = await fetch("/lp/aboard/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, offer, edition, company }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error(`[lp/aboard] claim failed, status ${res.status}:`, data);
      showError(
        res.status === 429
          ? "That is a lot of tries from one place. Give it an hour and we will be here."
          : data.error || "We could not issue your code just now."
      );
      return;
    }

    const target = targetFor(data.state, offer, edition);
    const cartUrl = buildCartUrl(target.offer, target.edition, data.code);

    render(data.state, { code: data.code, cartUrl, offer: target.offer });
  } catch (err) {
    console.error("[lp/aboard] claim request never completed:", err);
    showError("We could not reach the ship. Check your connection and try again.");
  } finally {
    submitBtn.removeAttribute("aria-busy");
    submitBtn.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});

// The nav language chips pick the edition. There is no translated version of this
// page, so they scroll to the picker rather than pretending to be a language switch.
const langButtons = Array.from(document.querySelectorAll(".np-lang"));
const editionInputs = Array.from(form.querySelectorAll('input[name="edition"]'));

function syncLangChips() {
  const current = chosen("edition");
  for (const btn of langButtons) btn.classList.toggle("is-on", btn.dataset.lang === current);
}

for (const btn of langButtons) {
  btn.addEventListener("click", () => {
    const input = form.querySelector(`input[name="edition"][value="${btn.dataset.lang}"]`);
    if (!input) {
      console.error(`[lp/aboard] nav chip "${btn.dataset.lang}" has no matching edition input`);
      return;
    }
    input.checked = true;
    syncLangChips();
    document.getElementById("offer").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
for (const input of editionInputs) input.addEventListener("change", syncLangChips);
syncLangChips();

// Reviews turn themselves over on narrow screens, where they are a swipe strip.
(function reviewCarousel() {
  const strip = document.querySelector(".quotes");
  if (!strip) return;

  const narrow = window.matchMedia("(max-width:600px)");
  const reduced = window.matchMedia("(prefers-reduced-motion:reduce)");
  let timer = null;
  let paused = false;
  let pauseTimer = null;

  function cardWidth() {
    const card = strip.querySelector(".q-card");
    return card ? card.getBoundingClientRect().width + 14 : 280;
  }

  function step() {
    if (paused || !narrow.matches) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const next = strip.scrollLeft + cardWidth();
    strip.scrollTo({ left: next > max - 4 ? 0 : next, behavior: "smooth" });
  }

  function hold() {
    paused = true;
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(() => { paused = false; }, 6000);
  }

  for (const event of ["pointerdown", "touchstart", "wheel"]) {
    strip.addEventListener(event, hold, { passive: true });
  }

  function run() {
    clearInterval(timer);
    if (narrow.matches && !reduced.matches) timer = setInterval(step, 4200);
    else strip.scrollTo({ left: 0 });
  }

  narrow.addEventListener("change", run);
  run();
})();
