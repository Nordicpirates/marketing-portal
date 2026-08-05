// Page behaviour for /gift-offer.
//
// The form posts to /gift-offer/claim and the answer decides what gets rendered into
// #result. Cart links are built here, in the browser, from the offer and edition the
// visitor chose plus the code the endpoint sent back. The codes are never written into
// this file or the HTML - they rotate.

import { buildCartUrl } from "./offer.js";

const form = document.getElementById("giftform");
const result = document.getElementById("result");
const submitBtn = document.getElementById("submit-btn");
const emailInput = document.getElementById("email");
const offerSection = document.getElementById("offer");
const claimSection = document.querySelector(".claim");

// One state serves every offer, so the cart button has to say what it is really
// loading. A BIG BOX cart is three items, not "the game and the gift".
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

function scrollToSection(el) {
  if (!el) {
    console.error("[lp/aboard] asked to scroll somewhere that is not on the page");
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showError(message) {
  render("error", { message });
}

/**
 * Swap #result for one of the <template> states.
 *
 * Returns the element that landed, so a caller can wire up the buttons inside it.
 * Null means the template was missing, and the caller has nothing to wire.
 */
function render(kind, data = {}) {
  const tpl = document.getElementById(`tpl-${kind}`);
  if (!tpl) {
    console.error(`[lp/aboard] no template for state "${kind}"`);
    result.textContent = "Something went wrong on our side. Please try again.";
    return null;
  }

  const node = tpl.content.cloneNode(true);
  const state = node.firstElementChild;

  const fill = (selector, value) => {
    const el = node.querySelector(selector);
    if (el && value) el.textContent = value;
  };
  fill("[data-title]", data.title);
  fill("[data-lead]", data.lead);
  fill("[data-message]", data.message);
  fill("[data-code]", data.code);

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
  return state;
}

/** Hand over one code, with the cart link that this exact code fits. */
function showCode({ title, lead, code, offer, edition }) {
  const cartUrl = buildCartUrl(offer, edition, code);
  render("code", { title, lead, code, cartUrl, offer });
}

/**
 * The blocked answer, the only one with a decision left in it.
 *
 * Nothing here goes back to the server. The email is already stored and both codes are
 * already issued; all that is left is which cart the visitor wants and which of the two
 * codes fits it. Taking a European edition keeps the Base Game code they were issued
 * and emailed; taking the BIG BOX swaps in the BIG BOX code. Both codes are scoped to
 * their product rather than to one variant, so every language edition qualifies and
 * neither choice leaves anyone holding a code their cart refuses.
 */
function showBlocked({ code, baseCode, offer, edition }) {
  const warning = render("blocked");
  if (!warning) return;

  const takeBigBox = () => {
    showCode({
      title: "The BIG BOX in English it is",
      // No word about the inbox on this branch: the code we mail this visitor is the
      // Base Game one they were issued, not this one. Promising otherwise would be a
      // promise made by the wrong half of the system.
      lead: "Here is the code that fits it. The button below loads the box and both gifts together.",
      code,
      offer: "bigbox-both",
      edition,
    });
  };

  const takeEdition = (input) => {
    // Leave the picker at the top of the page agreeing with what they just chose, so
    // scrolling back up does not show them the edition we already refused.
    input.checked = true;
    syncLangChips();
    showCode({
      title: "Aboard, in your language",
      lead: "Your code has not changed, and it is already on its way to your inbox.",
      code: baseCode,
      offer,
      edition: input.value,
    });
  };

  const showEditions = () => {
    const picker = render("editions");
    if (!picker) return;

    const list = picker.querySelector("[data-editions]");
    if (!list) {
      console.error("[lp/aboard] the edition template has nowhere to put the editions");
      return;
    }

    // Built from the edition picker in the form rather than from a second list kept
    // here, so there is one set of editions on this page and it cannot drift.
    for (const input of form.querySelectorAll('input[name="edition"]')) {
      if (input.value === edition) continue; // the one we just said we cannot ship

      const label = form.querySelector(`label[for="${input.id}"]`);
      if (!label) console.warn(`[lp/aboard] edition "${input.value}" has no label, using its code`);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.dataset.edition = input.value;
      button.textContent = label ? label.textContent.trim() : input.value.toUpperCase();
      button.addEventListener("click", () => takeEdition(input));
      list.append(button);
    }

    if (!list.children.length) {
      console.error("[lp/aboard] no other edition to offer, the form has only the blocked one");
    }
    wireChoices(picker);
  };

  const wireChoices = (root) => {
    for (const button of root.querySelectorAll("[data-choice]")) {
      button.addEventListener("click", () => {
        if (button.dataset.choice === "package") takeBigBox();
        else showEditions();
      });
    }
  };

  if (!baseCode) {
    // Without it the language choice cannot build a cart carrying a working code, and
    // a cart with no code hands over no gift. One honest choice beats two where one of
    // them is quietly broken.
    console.error(
      "[lp/aboard] blocked answer carried no base code, so the language choice cannot be offered"
    );
    const language = warning.querySelector('[data-choice="edition"]');
    if (language) language.remove();
  }

  wireChoices(warning);
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
    const res = await fetch("/gift-offer/claim", {
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

    if (data.state === "blocked") {
      showBlocked({ code: data.code, baseCode: data.baseCode, offer, edition });
    } else if (data.state === "code") {
      showCode({ code: data.code, offer, edition });
    } else {
      console.error(`[lp/aboard] claim answered with a state this page does not know: ${data.state}`);
      showError("We could not issue your code just now.");
      return;
    }

    giftJump.retire();
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
    scrollToSection(offerSection);
  });
}
for (const input of editionInputs) input.addEventListener("change", syncLangChips);
syncLangChips();

// Choosing a box is the moment the next step has to become unmistakable, so it takes
// the visitor to the email field and puts the cursor in it.
//
// Pointer clicks only. Arrow keys walk through a radio group and fire a click of their
// own with detail 0, and pulling focus out of the group on those would strand a
// keyboard visitor on whichever box they happened to arrow onto.
for (const pick of form.querySelectorAll(".pick")) {
  pick.addEventListener("click", (event) => {
    if (event.detail === 0) return;
    // Focus first, so it is still the visitor's own tap that opens the keyboard on a
    // phone, and scroll after, so the smooth scroll has the last word on where the
    // page ends up instead of fighting the jump focus() would otherwise cause.
    emailInput.focus({ preventScroll: true });
    scrollToSection(claimSection);
  });
}

// The button that follows the visitor down the page. It is a router, not a nag: it
// shows only while nothing else on screen already leads to the picker, and it goes for
// good once a code has been handed over. Watching the claim form is also what keeps it
// off the claim form, which on a phone is the one place it must never sit.
const giftJump = (function stickyRouter() {
  const nothingToRetire = { retire() {} };

  const button = document.getElementById("gift-jump");
  if (!button) {
    console.error("[lp/aboard] the sticky gift button is missing from the page");
    return nothingToRetire;
  }

  button.addEventListener("click", () => scrollToSection(offerSection));

  const landmarks = [document.querySelector(".hero-cta"), offerSection, claimSection].filter(Boolean);
  if (!landmarks.length) {
    console.error("[lp/aboard] found none of the sections the gift button hides behind, leaving it hidden");
    return nothingToRetire;
  }

  if (typeof IntersectionObserver !== "function") {
    console.warn("[lp/aboard] no IntersectionObserver in this browser, so the gift button stays hidden");
    return nothingToRetire;
  }

  const onScreen = new Set();
  let retired = false;

  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreen.add(entry.target);
      else onScreen.delete(entry.target);
    }
    button.hidden = retired || onScreen.size > 0;
  });
  for (const el of landmarks) watch.observe(el);

  return {
    retire() {
      retired = true;
      watch.disconnect();
      button.hidden = true;
    },
  };
})();

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
