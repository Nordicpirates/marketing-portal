// Page behaviour for /gift-offer.
//
// The form posts to /gift-offer/claim and the answer decides what happens next. On a
// plain success that is not a panel to read: the page loads the visitor's real Shopify
// cart with the game, the gift and the code, then takes them to /cart. The cart calls
// themselves live in ./cart.js. Codes are never written into this file or the HTML -
// they rotate, and the only one this page ever knows is the one it was just handed.

import { buildCartUrl } from "./offer.js";
import { loadCart } from "./cart.js";

const form = document.getElementById("giftform");
const result = document.getElementById("result");
const submitBtn = document.getElementById("submit-btn");
const emailInput = document.getElementById("email");
const offerSection = document.getElementById("offer");
const claimTitle = document.getElementById("claim-title");

// The demo and test escape. With ?no_redirect=1 the page hands over the code and its
// cart link the old way and touches nobody's cart, so the live flow can be checked on
// the real shop without emptying and refilling the reviewer's own basket.
const noRedirect = new URLSearchParams(window.location.search).get("no_redirect") === "1";

// How long "Code unlocked" stays on screen before the page navigates. Long enough to
// be read, short enough that nobody wonders whether the button worked. The cart calls
// run during it, so this is a floor on the wait and not an addition to it.
const CONFIRM_MS = 800;

// One state serves every offer, so the cart button has to say what it is really
// loading. A BIG BOX cart is three items, not "the game and the gift".
const CART_COPY = {
  "bigbox-both": {
    label: "Put the BIG BOX and both gifts in my cart",
    note: "One click loads all three items.",
  },
};

// The heading over the email field names the gift they just clicked, so the ask reads
// as the last step of what they were already doing rather than a toll gate. Polly's
// copy, one line per box, because "both gifts are yours" is not "the Kraken is yours"
// with a word swapped.
const CLAIM_TITLES = {
  "base-kraken": "One step and the Kraken is yours",
  "base-coins": "One step and the gold coins are yours",
  "bigbox-both": "One step and both gifts are yours",
};
const CLAIM_TITLE_FALLBACK = "One step and your gift is yours";

// Shown instead of the cart when the cart could not be built. It promises nothing
// about anybody's inbox: on one branch of the blocked flow the code on screen is not
// the code we mail, and this copy is used by every branch.
const CART_FAILED = {
  title: "Your code is safe, your cart is not loaded",
  lead: "We could not load your cart just now. Your code is below and it still works, so nothing is lost. Try again, or use the cart button.",
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

/**
 * Wait for the page to stop moving, then run.
 *
 * A phone is still settling when a tap lands: the keyboard slides up, the address bar
 * changes height, the sticky nav re-measures. Scrolling in the same tick aims at the
 * page as it was before all that and stops short of where the visitor needs to be.
 * A frame plus a task later, the layout is the one they will actually see.
 */
function afterLayout(run) {
  if (typeof window.requestAnimationFrame !== "function") {
    console.warn("[lp/aboard] no requestAnimationFrame here, scrolling without waiting");
    setTimeout(run, 0);
    return;
  }
  window.requestAnimationFrame(() => setTimeout(run, 0));
}

/**
 * Put the visitor in the email field.
 *
 * The field, not the section around it. On a phone the claim section starts a heading
 * and two paragraphs above the input, so scrolling to the section leaves the thing
 * they have to fill in below the fold. Centred, so it is clear of the sticky nav at
 * the top and of the keyboard at the bottom.
 */
function goToEmail() {
  // Focus first, so it is still the visitor's own tap that opens the keyboard on a
  // phone, and scroll after, so the smooth scroll has the last word on where the page
  // ends up instead of fighting the jump focus() would otherwise cause.
  emailInput.focus({ preventScroll: true });
  afterLayout(() => emailInput.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function showError(message) {
  render("error", { message });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

  // Only the state that follows a cart we could not build has anything to retry.
  // Everywhere else the button is taken out rather than left on screen doing nothing.
  const retry = node.querySelector("[data-retry]");
  if (retry) {
    if (data.retry) {
      retry.hidden = false;
      retry.addEventListener("click", data.retry);
    } else {
      retry.remove();
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

  // The blocked visitor answers inside this panel, and the button they press is gone a
  // moment later. Without this, focus falls back to the top of the document and anyone
  // on a keyboard or a screen reader has to find their way down here again. Only when
  // they were working in the panel: a render that follows the submit button leaves
  // focus where the visitor put it.
  const wasWorkingInPanel = result.contains(document.activeElement);

  result.replaceChildren(node);

  if (wasWorkingInPanel && state) {
    const heading = state.querySelector("h3");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }

  result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return state;
}

/** Hand over one code, with the cart link that this exact code fits. */
function showCode({ title, lead, code, offer, edition, retry }) {
  const cartUrl = buildCartUrl(offer, edition, code);
  render("code", { title, lead, code, cartUrl, offer, retry });
}

function goTo(url) {
  // Not the url: on the discount-fallback path it carries the code, and codes stay
  // out of logs. Which road was taken is visible one line up in loadCart's own logs.
  console.log("[lp/aboard] cart is loaded, going to it");
  window.location.assign(url);
}

/**
 * Finish one claim: the code is decided, now put it to work.
 *
 * The visitor asked for a game, not for a code to copy somewhere, so the page loads
 * their cart and takes them to it. The code goes on the cart on the way in. What they
 * see in between says so, and stays up long enough to be read.
 *
 * Two ways out of the redirect:
 *  - ?no_redirect=1, which hands over the code and its cart link and touches no cart;
 *  - a cart that could not be built, where the code stays on screen with the fallback
 *    cart link and a retry. Losing the code because the shop had a bad moment would
 *    be the one unrecoverable outcome here.
 */
async function completeWith(claim) {
  if (noRedirect) {
    console.log("[lp/aboard] no_redirect=1, showing the code instead of loading the cart");
    showCode(claim);
    return;
  }

  render("sending");
  const legible = wait(CONFIRM_MS);

  const cart = await loadCart(claim.offer, claim.edition, claim.code);
  if (!cart.ok) {
    showCode({
      ...claim,
      title: CART_FAILED.title,
      lead: CART_FAILED.lead,
      retry: () => completeWith(claim),
    });
    return;
  }

  await legible;
  goTo(cart.url);
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
 *
 * No cart is touched until they have chosen. Loading one for a package we have just
 * said we cannot ship would be the same mistake in a new place.
 */
function showBlocked({ code, baseCode, offer, edition }) {
  const warning = render("blocked");
  if (!warning) return;

  const takeBigBox = () => {
    completeWith({
      title: "The BIG BOX in English it is",
      // No word about the inbox on this branch: the code we mail this visitor is the
      // Base Game one they were issued, not this one. Promising otherwise would be a
      // promise made by the wrong half of the system.
      lead: "Here is the code that fits it. It loads the box and both gifts together.",
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
    completeWith({
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

    if (data.state !== "code" && data.state !== "blocked") {
      console.error(`[lp/aboard] claim answered with a state this page does not know: ${data.state}`);
      showError("We could not issue your code just now.");
      return;
    }

    // The picker has done its job, so the button that points at it goes now rather
    // than after the cart, where it would sit on the confirmation for a second.
    giftJump.retire();

    if (data.state === "blocked") showBlocked({ code: data.code, baseCode: data.baseCode, offer, edition });
    else await completeWith({ code: data.code, offer, edition });
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

/** Keep the heading over the email field naming the box that is currently chosen. */
function syncClaimTitle() {
  if (!claimTitle) {
    console.error("[lp/aboard] the claim heading is missing from the page");
    return;
  }
  const offer = chosen("offer");
  const title = CLAIM_TITLES[offer];
  if (!title) console.error(`[lp/aboard] no claim heading written for offer "${offer}"`);
  claimTitle.textContent = title || CLAIM_TITLE_FALLBACK;
}

// Choosing a box is the moment the next step has to become unmistakable, so it takes
// the visitor to the email field and puts the cursor in it.
//
// Pointer clicks only. Arrow keys walk through a radio group and fire a click of their
// own with detail 0, and pulling focus out of the group on those would strand a
// keyboard visitor on whichever box they happened to arrow onto. The heading and the
// sticky button still follow an arrow-key choice, through the change event below.
for (const pick of form.querySelectorAll(".pick")) {
  pick.addEventListener("click", (event) => {
    if (event.detail === 0) return;
    // Clicking the box that was already selected fires no change event, and it is
    // still a visitor choosing that box.
    giftJump.chose();
    goToEmail();
  });
}

for (const input of form.querySelectorAll('input[name="offer"]')) {
  input.addEventListener("change", () => {
    syncClaimTitle();
    giftJump.chose();
  });
}
syncClaimTitle();

// The button that follows the visitor down the page. It has two jobs and knows which
// one it is doing: before a box is chosen it goes to the picker, after it goes to the
// email field. It shows whenever neither of those is on screen, and it goes for good
// once a code has been handed over.
//
// The state is three flags and nothing else. It used to hide whenever the hero, the
// picker or the claim section was in view, which between them cover nearly the whole
// page, so on a phone it was never seen at all.
const giftJump = (function stickyRouter() {
  const inert = { retire() {}, chose() {} };

  const button = document.getElementById("gift-jump");
  if (!button) {
    console.error("[lp/aboard] the sticky gift button is missing from the page");
    return inert;
  }

  // The picker, because that is where it sends people who have not chosen, and the
  // email field, because that is where it sends everybody else. Nothing else on the
  // page has a say: a visitor reading the reviews with the picker off screen is
  // exactly who this button is for.
  const landmarks = [offerSection, emailInput].filter(Boolean);
  if (landmarks.length !== 2) {
    console.error("[lp/aboard] the picker or the email field is missing, leaving the gift button hidden");
    return inert;
  }

  if (typeof IntersectionObserver !== "function") {
    console.warn("[lp/aboard] no IntersectionObserver in this browser, so the gift button stays hidden");
    return inert;
  }

  const onScreen = new Set();
  let reported = false;
  let chose = false;
  let retired = false;

  // Three flags, one answer, and nothing that depends on which order things happened
  // in. Until the observer has said something, "what is on screen" is not empty, it
  // is unknown, and the button stays out of the way.
  function paint() {
    button.hidden = retired || !reported || onScreen.size > 0;
    button.textContent = chose ? "Continue to email" : "Pick your gift!";
  }

  button.addEventListener("click", () => {
    if (chose) goToEmail();
    else scrollToSection(offerSection);
  });

  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onScreen.add(entry.target);
      else onScreen.delete(entry.target);
    }
    reported = true;
    paint();
  });
  for (const el of landmarks) watch.observe(el);

  return {
    chose() {
      chose = true;
      paint();
    },
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
