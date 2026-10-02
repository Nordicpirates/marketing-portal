// The calendar day an instant falls on in Stockholm, as YYYY-MM-DD. Shared by the portal and
// the QR edge so a "day" means the same on both sides. docs/QR-LINKS.md
export function stockholmDay(at) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
