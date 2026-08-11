// Which words the gift page shows, in the language the visitor picked.
//
// The five nav chips are a real language switch: they translate every visitor-facing
// string on the page, the result panel included, and they select the matching
// physical edition in the picker. One list of languages, used by both jobs, so the
// page a visitor reads and the box we ship can never disagree.
//
// Copy lives one file per language. Nothing here is user input and nothing is ever
// written as HTML: every string lands as textContent or as an attribute value, so a
// stray angle bracket in somebody's translation is text and not markup.
//
// The English table is also the words in public/lp-aboard.html. That is deliberate:
// the page reads correctly before this module runs, and if it never runs. A test
// asserts the two say the same thing, so a copy change in one is a failure until it
// is made in the other.

import { EN } from "./i18n-en.js";
import { DE } from "./i18n-de.js";
import { IT } from "./i18n-it.js";
import { FR } from "./i18n-fr.js";
import { ES } from "./i18n-es.js";

/** The five the page sells in, in the order the nav chips sit in. */
export const LANGUAGES = ["en", "de", "it", "fr", "es"];

export const FALLBACK_LANGUAGE = "en";

const TABLES = { en: EN, de: DE, it: IT, fr: FR, es: ES };

/**
 * One string, in one language.
 *
 * Falls back to English rather than showing a key or a blank, and says so loudly
 * either way: a missing translation is a copy job somebody has to finish, and a page
 * that quietly swallows it is a page nobody fixes.
 */
export function text(lang, key) {
  const table = TABLES[lang];
  if (!table) {
    console.error(`[lp/aboard] no copy table for language "${lang}", falling back to English`);
    return text(FALLBACK_LANGUAGE, key);
  }

  const value = table[key];
  if (value !== undefined) return value;

  console.error(`[lp/aboard] no "${lang}" copy for "${key}"`);
  return lang === FALLBACK_LANGUAGE ? "" : text(FALLBACK_LANGUAGE, key);
}

// Attributes a visitor can hear or read even though they are not on screen as text.
// Alt text and aria labels are copy, so they switch with everything else.
const ATTRIBUTES = {
  "data-i18n-alt": "alt",
  "data-i18n-aria-label": "aria-label",
};

/**
 * Rewrite every keyed string inside `root` in `lang`.
 *
 * Works on the document and on a cloned <template> alike, which is how a result
 * panel comes out in the right language without a second copy of its wording living
 * in the JavaScript.
 */
export function translate(root, lang) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = text(lang, el.getAttribute("data-i18n"));
  }

  for (const [attribute, target] of Object.entries(ATTRIBUTES)) {
    for (const el of root.querySelectorAll(`[${attribute}]`)) {
      el.setAttribute(target, text(lang, el.getAttribute(attribute)));
    }
  }
}

/**
 * The whole page, plus the one thing that is not a string: the document's own
 * language, which is what a screen reader picks its voice from.
 */
export function translateDocument(doc, lang) {
  translate(doc, lang);
  doc.documentElement.lang = lang;
}
