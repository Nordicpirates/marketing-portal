// Page behaviour for /gift-offer.
//
// The form posts to /gift-offer/claim and the answer decides what happens next. On a
// plain success the page shows the visitor the code it was just handed, holds it on
// screen long enough to read, and meanwhile loads their real Shopify cart with the
// game, the gift and the code, then takes them to /cart. The cart calls themselves
// live in ./cart.js. Codes are never written into this file or the HTML - they
// rotate, and the only one this page ever knows is the one it was just handed.
//
// The page also speaks five languages. Every visitor-facing string comes out of
// ./i18n.js, keyed by the language the visitor picked in the nav, and the language
// and the physical edition in the picker are the same choice: pick DE and the page
// is in German AND the German box is what we ship. Nothing here holds copy of its
// own, so a state that is on screen when the language changes is rebuilt in the new
// language rather than being left behind in the old one. Because those two are one
// choice, both ends of it are held still while a claim is in flight and while the
// cart is being built: see holdChoice.

import { buildCartUrl } from "./offer.js";
import { loadCart } from "./cart.js";
import { text, translate, translateDocument } from "./i18n.js";

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

// How long the code stays on screen before the page navigates. The visitor is being
// moved to another page on their behalf, and they should have read the code they just
// asked for before that happens. The cart calls run during it, so this is a floor on
// the wait and not an addition to it.
const CODE_VISIBLE_MS = 2500;

// The heading over the email field names the gift they just clicked, so the ask reads
// as the last step of what they were already doing rather than a toll gate. One key
// per box, because "both gifts are yours" is not "the Kraken is yours" with a word
// swapped, in any language.
const CLAIM_TITLE_KEYS = {
  "base-kraken": "claim.title.kraken",
  "base-coins": "claim.title.coins",
  "bigbox-both": "claim.title.bigbox",
};

// One state serves every offer, so the cart button has to say what it is really
// loading. A BIG BOX cart is three items, not "the game and the gift".
const CART_COPY_KEYS = {
  "bigbox-both": { label: "state.cart.bigbox.label", note: "state.cart.bigbox.note" },
};

// The language the page is in, which is also the edition we will ship. Read once from
// the radio that is checked in the markup, and from then on every change goes through
// setLanguage, so the two can never answer differently.
let language = chosen("edition") || "en";

/** One string, in the language the page is currently in. */
function t(key) {
  return text(language, key);
}

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

function showError(messageKey) {
  render("error", { messageKey });
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// How to draw the panel that is on screen right now, again. A language change rebuilds
// it from this rather than translating what is already there: the copy in a state comes
// half from the template and half from whichever branch of the flow rendered it, and
// only the branch knows which half is which. Null before anything has been rendered.
let repaintPanel = null;

/**
 * Swap #result for one of the <template> states.
 *
 * Returns the element that landed, so a caller can wire up the buttons inside it.
 * Null means the template was missing, and the caller has nothing to wire.
 *
 * Everything the caller passes is a KEY, not a sentence. That is what lets the same
 * call be replayed in another language when the visitor switches mid flow.
 */
function render(kind, data = {}, options = {}) {
  const tpl = document.getElementById(`tpl-${kind}`);
  if (!tpl) {
    console.error(`[lp/aboard] no template for state "${kind}"`);
    result.textContent = t("error.template");
    return null;
  }

  const node = tpl.content.cloneNode(true);
  const state = node.firstElementChild;

  // The template's own wording first, in the current language. Anything this caller
  // has an opinion about is written over it below.
  translate(node, language);

  if (!options.repaint) repaintPanel = () => render(kind, data, { repaint: true });

  const fill = (selector, value) => {
    const el = node.querySelector(selector);
    if (el && value) el.textContent = value;
  };
  fill("[data-title]", data.titleKey && t(data.titleKey));
  fill("[data-lead]", data.leadKey && t(data.leadKey));
  fill("[data-message]", data.messageKey && t(data.messageKey));
  fill("[data-code]", data.code);

  const copyFor = CART_COPY_KEYS[data.offer];
  if (copyFor) {
    const note = node.querySelector("[data-cart-note]");
    if (note) note.textContent = t(copyFor.note);
  }

  const cart = node.querySelector("[data-cart]");
  if (cart) {
    if (copyFor) cart.textContent = t(copyFor.label);
    const cartUrl = buildCartUrl(data.offer, data.edition, data.code);
    if (cartUrl) {
      cart.href = cartUrl;
      // This link is a way off the page, so a caller that is holding the choice has to
      // let go of it here for the same reason the redirect does: the browser freezes
      // this document on the way out, and a hold still standing at that moment is
      // standing again when the visitor presses Back onto it. Nothing is prevented -
      // the link is their road to the shop and it still has to be walked.
      if (data.leaving) cart.addEventListener("click", data.leaving);
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
        copy.textContent = t("state.copied");
        setTimeout(() => { copy.textContent = t("state.copy"); }, 2000);
      } catch (err) {
        // Clipboard is blocked on insecure origins and by some browsers. The code
        // is on screen either way, so say so rather than failing silently.
        console.warn("[lp/aboard] clipboard write refused:", err);
        copy.textContent = t("state.copySelect");
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

  // A repaint is the same panel in another language, in the place the visitor already
  // has on screen. Dragging the page to it would punish them for using the nav.
  if (!options.repaint) result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return state;
}

/** Hand over one code, with the cart link that this exact code fits. */
function showCode(claim) {
  render("code", claim);
}

function goTo(url) {
  // Not the url: on the discount-fallback path it carries the code, and codes stay
  // out of logs. Which road was taken is visible one line up in loadCart's own logs.
  console.log("[lp/aboard] cart is loaded, going to it");
  window.location.assign(url);
}

// How to hand back the hold of the attempt that is still waiting on this page, if one
// is. Only a cart that would not build leaves one waiting: its panel keeps the hold so
// the retry beside it carts what the page is showing. Null whenever nothing is pending,
// which is every other moment on this page.
let attemptWaiting = null;

/**
 * Finish one claim: the code is decided, now put it to work.
 *
 * The visitor asked for a game, not for a code to copy somewhere, so the page loads
 * their cart and takes them to it. The code goes on the cart on the way in. What they
 * see in between IS the code, in full, and it stays up long enough to be read: the
 * page is about to navigate on their behalf, and a code that flashed past is a code
 * they never got.
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

  render("sending", { code: claim.code, offer: claim.offer, edition: claim.edition });
  // The cart being built is this claim's, and the visitor is about to be moved to it.
  // Same reason as during the claim itself, and this is also the road a retry comes
  // back down, so the hold is here rather than only around the request.
  holdChoice(true);
  const legible = wait(CODE_VISIBLE_MS);

  const cart = await loadCart(claim.offer, claim.edition, claim.code);
  if (!cart.ok) {
    // The hold stays. The panel that lands carries a retry, and the retry builds a cart
    // for THIS claim: the edition that was posted, the one the endpoint agreed it could
    // ship, and the one the code was issued against. Handing the choice back here would
    // let the visitor move the page to another language and then press a button that
    // carts the old one, which is the same disagreement one screen further on. It would
    // also let them move it to the English Base Game, which is the one combination the
    // endpoint refuses for a European visitor and the only one it can decide: it knows
    // where they are and this page never does.
    //
    // So the choice comes back when nothing is pending, which here means the cart they
    // end up on. There are two roads to it off this panel and the hold is handed back on
    // whichever one they take: the retry, which hands it straight to the attempt it
    // starts, and the fallback cart link, which hands it back because the page is about
    // to leave through it and a hold that leaves with the page comes back with it.
    //
    // Once, whichever road, and once no matter how many times they take it. Pressing
    // retry five times holds once and not five times, and a visitor who follows the link
    // and then presses Back and retries is not releasing a hold that is already released.
    //
    // Which leaves the one gap the hold cannot cover: the page that comes back after the
    // link was followed has this panel on it AND the controls free, because the hold went
    // out of the door with them. So the retry does not lean on the hold being up when it
    // is pressed. It puts the page back on the box it is about to cart, every time.
    let handedBack = false;
    const handBack = () => {
      if (handedBack) return;
      handedBack = true;
      if (attemptWaiting === handBack) attemptWaiting = null;
      holdChoice(false);
    };

    // There is a third road off this panel that is not a button on it: the form is still
    // up the page and the submit button is live again, so the visitor can start a fresh
    // claim instead of answering this one. That abandons this attempt, and submit hands
    // its hold back on the way past. Without that the hold outlives the attempt it was
    // guarding and rides the next claim's page into the browser's cache, which is the
    // locked page all over again.
    attemptWaiting = handBack;

    showCode({
      ...claim,
      titleKey: "state.cartFailed.title",
      leadKey: "state.cartFailed.lead",
      retry: () => {
        handBack();
        // The browser may have handed this page back since the attempt failed. The hold
        // ended when they left through the cart link, so both controls have been theirs
        // again in the meantime and can be pointing anywhere by now, while the attempt
        // this button starts is still the old claim's.
        //
        // The claim wins. It is the edition the endpoint agreed it could ship to this
        // visitor, and it is what the code was issued against, so the page comes back to
        // it rather than the cart following the picker. Same answer takeEdition gives on
        // the blocked road, and the visitor sees it happen before the cart is built
        // rather than reading one box and being sent another. No repaint: the panel this
        // would redraw is the one completeWith replaces on the next line.
        setLanguage(claim.edition, { repaint: false });
        setOffer(claim.offer);
        completeWith(claim);
      },
      leaving: handBack,
    });
    return;
  }

  await legible;
  // The cart is built and the page is leaving. This hold ends with the page it was
  // taken on: the browser freezes the document as it goes, and a hold still standing at
  // that moment comes back standing when the visitor presses Back onto it.
  holdChoice(false);
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
  const takeBigBox = () => {
    completeWith({
      titleKey: "state.bigbox.title",
      // No word about the inbox on this branch: the code we mail this visitor is the
      // Base Game one they were issued, not this one. Promising otherwise would be a
      // promise made by the wrong half of the system.
      leadKey: "state.bigbox.lead",
      code,
      offer: "bigbox-both",
      edition,
    });
  };

  const takeEdition = (input) => {
    // Leave the picker at the top of the page agreeing with what they just chose, so
    // scrolling back up does not show them the edition we already refused. That is a
    // language change as much as an edition one, so the panel they are about to read
    // comes out in the language of the box they just asked for. No repaint: the panel
    // this would redraw is the one completeWith replaces on the next line.
    setLanguage(input.value, { repaint: false });
    completeWith({
      titleKey: "state.edition.title",
      leadKey: "state.edition.lead",
      code: baseCode,
      offer,
      edition: input.value,
    });
  };

  const wireChoices = (root) => {
    for (const button of root.querySelectorAll("[data-choice]")) {
      button.addEventListener("click", () => {
        if (button.dataset.choice === "package") takeBigBox();
        else show("editions");
      });
    }
  };

  const screens = {
    warning(repaint) {
      const warning = render("blocked", {}, { repaint });
      if (!warning) return;

      if (!baseCode) {
        // Without it the language choice cannot build a cart carrying a working code,
        // and a cart with no code hands over no gift. One honest choice beats two
        // where one of them is quietly broken.
        console.error(
          "[lp/aboard] blocked answer carried no base code, so the language choice cannot be offered"
        );
        const languageChoice = warning.querySelector('[data-choice="edition"]');
        if (languageChoice) languageChoice.remove();
      }

      wireChoices(warning);
    },

    editions(repaint) {
      const picker = render("editions", {}, { repaint });
      if (!picker) return;

      const list = picker.querySelector("[data-editions]");
      if (!list) {
        console.error("[lp/aboard] the edition template has nowhere to put the editions");
        return;
      }

      // Built from the edition picker in the form rather than from a second list kept
      // here, so there is one set of editions on this page and it cannot drift. The
      // names are the ones printed on the boxes, so they do not translate.
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
    },
  };

  // Which of the two screens the visitor is on, so a language change redraws the one
  // they are looking at and not the one they started on.
  const show = (name) => {
    screens[name](false);
    repaintPanel = () => screens[name](true);
  };

  show("warning");
}

// No "action" is ever sent. The endpoint refuses one, because a form post proves
// nothing about who owns the address in it and must not carry an instruction about
// somebody's mailing list. Re-subscribing needs a confirmed-email flow, not this.
async function submit() {
  const offer = chosen("offer");
  // The edition we ship is the language the page is in. They are one choice, tracked
  // in one place, so the box can never disagree with the words the visitor just read.
  const edition = language;
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
  // A claim that starts replaces whatever this page was still waiting on. If a cart that
  // would not build left its hold standing to guard a retry, the visitor is walking away
  // from that retry by being here, so its hold goes with it. Two attempts must not leave
  // two holds behind when only one of them can ever be released.
  if (attemptWaiting) {
    console.log("[lp/aboard] a new claim replaces the attempt still waiting, letting go of its hold");
    attemptWaiting();
  }
  // The gift and the edition above have just been posted, and the answer decides what
  // goes in the cart. From here until there is an answer, the choice is made and cannot
  // move.
  holdChoice(true);

  try {
    const res = await fetch("/gift-offer/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, offer, edition, company }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // The endpoint's own wording is English and is not shown: it goes in the log,
      // where whoever is debugging reads English anyway, and the visitor gets the
      // same sentence in the language the rest of the page is in.
      console.error(`[lp/aboard] claim failed, status ${res.status}:`, data);
      showError(res.status === 429 ? "error.rateLimited" : "error.generic");
      return;
    }

    if (data.state !== "code" && data.state !== "blocked") {
      console.error(`[lp/aboard] claim answered with a state this page does not know: ${data.state}`);
      showError("error.generic");
      return;
    }

    // The picker has done its job, so the button that points at it goes now rather
    // than after the cart, where it would sit on the confirmation for a second.
    giftJump.retire();

    if (data.state === "blocked") showBlocked({ code: data.code, baseCode: data.baseCode, offer, edition });
    else await completeWith({ code: data.code, offer, edition });
  } catch (err) {
    console.error("[lp/aboard] claim request never completed:", err);
    showError("error.network");
  } finally {
    submitBtn.removeAttribute("aria-busy");
    submitBtn.disabled = false;
    // Every road out of the block above ends somewhere the visitor has to act: an
    // error to try again from, the blocked choice, the code with its cart link, or a
    // page that is already navigating. All of those are theirs to steer. The two that
    // are not are the wait before a redirect and the retry left behind by a cart that
    // would not build, and completeWith holds both itself.
    holdChoice(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});

// The nav language chips ARE the language switch, and the same click picks the edition
// we ship. One control for one decision: a visitor reading the page in French is a
// visitor who wants the French box.
const langButtons = Array.from(document.querySelectorAll(".np-lang"));
const editionInputs = Array.from(form.querySelectorAll('input[name="edition"]'));
// The gift is the third control that feeds the cart, and it is posted in the same
// request as the edition. Everything below holds all three together, because the cart
// is built from all three and any one of them moving on its own is the same bug.
const offerInputs = Array.from(form.querySelectorAll('input[name="offer"]'));

/**
 * Hold every control that feeds the cart still, or let go of them.
 *
 * A claim is posted with the gift and the edition that were chosen when the button was
 * pressed, and the answer arrives some unknown time later. Without this, a chip or a box
 * tapped during that wait repaints the page and moves the picker while the cart is
 * already being built for what was sent: French words, French radio, English box, or a
 * BIG BOX on screen and the Base Game in the cart. The visitor never sees the
 * disagreement, because the next thing they see is the cart.
 *
 * Held, not ignored. The chips and both sets of radios are disabled, so they go the same
 * quiet way the submit button beside them already does, and a tap on one is visibly
 * refused rather than swallowed.
 *
 * Holds nest: each step releases only its own, so the wait before a redirect keeps its
 * hold when the submit that started it has already let go of theirs.
 *
 * The hold lasts as long as the page owes the visitor a cart for a decision that has
 * already been made: the claim in flight, the cart being built, and a cart that would
 * not build with a retry still on screen, which is the same decision waiting to be tried
 * again. A hold must not outlive the attempt it is guarding, because a page that
 * navigates while something is held comes back from the browser's cache exactly that
 * way, with controls the visitor cannot use and nothing left running to release them.
 * So every road that SETTLES the attempt lets go of the hold on the way: the redirect at
 * the end of completeWith, the retry, the fallback cart link beside it, and a fresh claim
 * from the form, which walks away from the attempt that was waiting.
 *
 * A departure that settles nothing does not, and that is the whole reason this is not a
 * blanket release on the way in or the way out. A visitor who reads the privacy policy
 * with a retry still on screen comes back to a page that is still holding, because the
 * decision it is holding for is still the one in front of them, and the retry is still
 * how they resolve it.
 */
let holds = 0;

function holdChoice(held) {
  holds += held ? 1 : -1;
  if (holds < 0) {
    console.error("[lp/aboard] the choice was released more often than it was held");
    holds = 0;
  }

  const frozen = holds > 0;
  for (const btn of langButtons) btn.disabled = frozen;
  for (const input of editionInputs) input.disabled = frozen;
  for (const input of offerInputs) input.disabled = frozen;
}

/** Whether the choice is being held right now. */
const choiceHeld = () => holds > 0;

function syncLangChips() {
  for (const btn of langButtons) btn.classList.toggle("is-on", btn.dataset.lang === language);
}

/**
 * Switch the page, the picker and the chips to one language, all three together.
 *
 * Everything that is on screen follows: the markup through its data-i18n keys, the
 * heading over the email field and the sticky button because they are written by this
 * file, and whatever result panel is up because it is drawn again from its keys.
 *
 * `repaint:false` is for the one caller that is about to replace the panel anyway.
 */
function setLanguage(value, { repaint = true } = {}) {
  const input = form.querySelector(`input[name="edition"][value="${value}"]`);
  if (!input) {
    console.error(`[lp/aboard] no edition on this page for language "${value}", leaving it alone`);
    return;
  }

  language = value;
  input.checked = true;

  translateDocument(document, language);
  syncLangChips();
  syncClaimTitle();
  giftJump.relabel();
  if (repaint && repaintPanel) repaintPanel();
}

// A disabled control delivers neither of these events in a browser, so the guard is
// for anything that arrives another way. It says so rather than returning quietly:
// somebody reading a log needs to see that a choice was made and refused.
for (const btn of langButtons) {
  btn.addEventListener("click", () => {
    if (choiceHeld()) {
      console.warn("[lp/aboard] language chip pressed while a claim is in flight, ignoring it");
      return;
    }
    setLanguage(btn.dataset.lang);
  });
}
// The picker further down is the same choice from the other end, so it switches the
// page too. Change, not click, so the keyboard's arrow keys count as well.
for (const input of editionInputs) {
  input.addEventListener("change", () => {
    if (choiceHeld()) {
      console.warn("[lp/aboard] edition changed while a claim is in flight, ignoring it");
      return;
    }
    setLanguage(input.value);
  });
}

/**
 * Put the picker back on one gift, with the heading over the email field following it.
 *
 * setLanguage for the other half of the claim, and it exists for the same one caller:
 * an attempt that has to bring the page back to the box it is about to cart. There is
 * no chip end to this one and no copy of its own to switch, so it is the two lines
 * setLanguage would have had left after the language work was taken out of it.
 */
function setOffer(value) {
  const input = form.querySelector(`input[name="offer"][value="${value}"]`);
  if (!input) {
    console.error(`[lp/aboard] no gift on this page called "${value}", leaving the picker alone`);
    return;
  }

  input.checked = true;
  syncClaimTitle();
}

/** Keep the heading over the email field naming the box that is currently chosen. */
function syncClaimTitle() {
  if (!claimTitle) {
    console.error("[lp/aboard] the claim heading is missing from the page");
    return;
  }
  const offer = chosen("offer");
  const key = CLAIM_TITLE_KEYS[offer];
  if (!key) console.error(`[lp/aboard] no claim heading written for offer "${offer}"`);
  claimTitle.textContent = t(key || "claim.title.fallback");
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
    // A held box does not become checked, so this click chose nothing. Answering it by
    // dragging the visitor up to the email field would tell them it landed.
    if (choiceHeld()) {
      console.warn("[lp/aboard] a gift was tapped while a claim is in flight, ignoring it");
      return;
    }
    // Clicking the box that was already selected fires no change event, and it is
    // still a visitor choosing that box.
    giftJump.chose();
    goToEmail();
  });
}

// Same guard as the two language controls, for the same reason and against the same
// window: the gift is posted with the edition and the cart is built from both, so a box
// that moved after the request went out would leave the page showing one gift and the
// cart holding another.
for (const input of offerInputs) {
  input.addEventListener("change", () => {
    if (choiceHeld()) {
      console.warn("[lp/aboard] gift changed while a claim is in flight, ignoring it");
      return;
    }
    syncClaimTitle();
    giftJump.chose();
  });
}

// The button that follows the visitor down the page. It has two jobs and knows which
// one it is doing: before a box is chosen it goes to the picker, after it goes to the
// email field. It shows whenever neither of those is on screen, and it goes for good
// once a code has been handed over.
//
// The state is three flags and nothing else. It used to hide whenever the hero, the
// picker or the claim section was in view, which between them cover nearly the whole
// page, so on a phone it was never seen at all.
const giftJump = (function stickyRouter() {
  const inert = { retire() {}, chose() {}, relabel() {} };

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
    button.textContent = t(chose ? "sticky.continue" : "sticky.pick");
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
    relabel() {
      if (!retired) paint();
    },
    retire() {
      retired = true;
      watch.disconnect();
      button.hidden = true;
    },
  };
})();

// Everything the page writes for itself, said once at load in whichever language the
// markup starts in. setLanguage repeats these on every switch after that, plus the two
// things that do not exist yet at load: the sticky button and the result panel.
translateDocument(document, language);
syncLangChips();
syncClaimTitle();

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
