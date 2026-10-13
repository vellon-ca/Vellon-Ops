import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// Hand-drawn PDF, same style as mgcj-app's send-ride-receipt Edge Function
// (also pdf-lib) — kept consistent rather than introducing a second PDF
// paradigm (e.g. react-pdf) into the stack.
//
// Vellon isn't incorporated yet, so every "from" field (legal name, address,
// business/HST number, payment instructions) may be blank — this builder
// omits each blank section entirely rather than printing "undefined" or a
// placeholder on a document a real company receives.

/** `ratePercent` NULL prints the line without a percentage. */
export type InvoiceTaxLine = { label: string; ratePercent: number | null; amount: number };

// WHAT THIS DOCUMENT MUST CARRY once it shows tax. CRA Memorandum 8-4, the
// $500-and-over tier (thresholds $100 / $500 since 2021-04-20), which is the
// superset: supplier's name, date, total, the tax charged, the supplier's
// GST/HST registration number, the recipient's name, terms of payment, and a
// description of the service. Each has a line below; do not drop one.
export type InvoicePdfInput = {
  invoiceNumber: string;
  periodLabel: string; // e.g. "June 2026"
  issueDate: string; // pre-formatted, e.g. "July 18, 2026"
  companyName: string;
  billingAddress: string | null;
  cashFaresTotal: number;
  feePercent: number;
  rideCount: number;
  /** The platform FEE alone, never fee+tax — see 0008_invoice_tax.sql. */
  amountDue: number;
  /**
   * NULL = no tax line on this document, which is correct whenever Vellon is
   * not GST/HST-registered. Snapshotted on the invoice row, never read live
   * off the company, so an issued document cannot be rewritten by a later
   * rate change. Tax is EXCLUSIVE here: added to the fee, not extracted.
   */
  tax: InvoiceTaxLine | null;
  /**
   * Vellon's fee on CARD fares: collected through Stripe when each fare was
   * charged, so stated here and never payable. NULL = no card rides this
   * period. Its tax line is what lets the company claim the input tax credit
   * on fees it never received a bill for.
   */
  card: {
    faresTotal: number;
    rideCount: number;
    fee: number;
    tax: InvoiceTaxLine | null;
    /**
     * Fees Vellon returned to the company DURING this period, whichever month
     * the ride was in. The tax line here is the credit the company adjusts its
     * input tax credit by. NULL = none returned.
     */
    returned: {
      rideCount: number;
      fee: number;
      tax: InvoiceTaxLine | null;
    } | null;
  } | null;
  /** amountDue + tax (cash only). Equals amountDue when `tax` is null. */
  totalDue: number;
  vellon: {
    legalName: string | null;
    businessNumber: string | null;
    hstNumber: string | null;
    mailingAddress: string | null;
    paymentInstructions: string | null;
  };
  /**
   * Set only for an unsaved preview: the text of a banner across the top. It
   * also prints a placeholder where a missing GST/HST number would otherwise
   * leave the registration line out, since the real generator refuses that
   * case and a preview does not.
   */
  preview?: string | null;
};

export async function buildInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // Letter

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.45, 0.45, 0.45);
  const lightGray = rgb(0.94, 0.94, 0.94);

  const left = 50;
  const right = 562;
  const W = right - left;

  const draw = (
    text: string,
    x: number,
    y: number,
    opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
  ) => {
    const { size = 11, font = regular, color = black, align = "left" } = opts;
    const drawX = align === "right" ? x - font.widthOfTextAtSize(text, size) : x;
    page.drawText(text, { x: drawX, y, size, font, color });
  };

  const rule = (y: number, color = lightGray) => {
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color });
  };

  const vellonName = input.vellon.legalName || "Vellon";

  let y = 742;

  if (input.preview) {
    page.drawRectangle({ x: 0, y: 768, width: 612, height: 24, color: rgb(0.75, 0.15, 0.15) });
    page.drawText(input.preview, { x: left, y: 776, size: 9, font: bold, color: rgb(1, 1, 1) });
  }

  // ── Header ──────────────────────────────────────────────────────────
  draw(vellonName, left, y, { size: 18, font: bold });
  draw("INVOICE", right, y, { size: 20, font: bold, align: "right" });

  y -= 20;
  if (input.vellon.mailingAddress) {
    draw(input.vellon.mailingAddress, left, y, { size: 9, color: gray });
  }
  draw(input.invoiceNumber, right, y, { size: 10, color: gray, align: "right" });

  y -= 14;
  // The registration line is gated on `tax`, NOT on hstNumber alone. Printing
  // "HST Reg: 12345" beside a document with no tax line was the original §3
  // defect: it asserts a taxable supply the invoice never charged for. One
  // gate, so the two halves of that claim cannot disagree. (BN is not a tax
  // claim and prints whenever it is configured.)
  // "Either section": a month of card rides only still charged tax.
  const anyTax = input.tax ?? input.card?.tax ?? input.card?.returned?.tax ?? null;
  const regNumbers = [
    input.vellon.businessNumber ? `BN: ${input.vellon.businessNumber}` : null,
    anyTax && input.vellon.hstNumber
      ? `${anyTax.label} Reg: ${input.vellon.hstNumber}`
      : anyTax && input.preview
        ? `${anyTax.label} Reg: [not set]`
        : null,
  ]
    .filter(Boolean)
    .join("   ");
  if (regNumbers) draw(regNumbers, left, y, { size: 9, color: gray });
  draw(input.issueDate, right, y, { size: 10, color: gray, align: "right" });

  y -= 18;
  rule(y);

  // ── Bill to ───────────────────────────────────────────────────────────
  y -= 16;
  draw("BILL TO", left, y, { size: 9, color: gray });

  y -= 16;
  draw(input.companyName, left, y, { size: 13, font: bold });

  if (input.billingAddress) {
    y -= 15;
    draw(input.billingAddress, left, y, { size: 10, color: gray });
  }

  y -= 12;
  draw(`Period: ${input.periodLabel}`, right, y + 15, { size: 10, color: gray, align: "right" });

  y -= 14;
  rule(y);

  // ── Line items ────────────────────────────────────────────────────────
  y -= 16;
  page.drawRectangle({ x: left, y: y - 5, width: W, height: 20, color: lightGray });
  draw("Description", left + 6, y, { size: 9, color: gray });
  draw("Amount", right - 6, y, { size: 9, color: gray, align: "right" });

  const taxText = (t: InvoiceTaxLine) =>
    t.ratePercent != null ? `${t.label} (${formatRate(t.ratePercent)}%)` : t.label;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const row = (text: string, amount: string, strong = false) => {
    draw(text, left + 6, y, strong ? { size: 11 } : { size: 10, color: gray });
    draw(amount, right - 6, y, strong ? { size: 11, align: "right" } : { size: 10, color: gray, align: "right" });
  };
  const plural = (n: number) => `${n} ride${n === 1 ? "" : "s"}`;

  // The service, described once (8-4: "sufficient to identify it").
  y -= 22;
  draw(`Vellon Dispatch platform fee — dispatch software service, ${input.periodLabel}`, left + 6, y, {
    size: 10,
  });

  // ── Cash fares: fee payable ───────────────────────────────────────────
  y -= 24;
  draw("CASH FARES — FEE PAYABLE", left + 6, y, { size: 9, color: gray });
  y -= 18;
  row(`Cash fares this period (${plural(input.rideCount)})`, money(input.cashFaresTotal), true);
  y -= 18;
  row(`Platform fee (${input.feePercent}%)`, money(input.amountDue));
  if (input.tax) {
    y -= 18;
    row(taxText(input.tax), money(input.tax.amount));
  }

  // ── Card fares: fee already collected ─────────────────────────────────
  if (input.card && input.card.rideCount > 0) {
    y -= 26;
    draw("CARD FARES — FEE ALREADY COLLECTED", left + 6, y, { size: 9, color: gray });
    y -= 18;
    row(`Card fares this period (${plural(input.card.rideCount)})`, money(input.card.faresTotal), true);
    y -= 18;
    row("Platform fee", money(input.card.fee));
    if (input.card.tax) {
      y -= 18;
      row(taxText(input.card.tax), money(input.card.tax.amount));
    }
    y -= 18;
    row(
      "Collected through Stripe when each fare was charged",
      `-${money(input.card.fee + (input.card.tax?.amount ?? 0))}`,
    );
  }

  // ── Fees returned: a credit, already paid back ────────────────────────
  const returned = input.card?.returned;
  if (returned) {
    y -= 26;
    draw("CARD FARES — FEE RETURNED TO YOU (CREDIT)", left + 6, y, { size: 9, color: gray });
    y -= 18;
    row(`Platform fee returned this period (${plural(returned.rideCount)})`, `-${money(returned.fee)}`, true);
    if (returned.tax) {
      y -= 18;
      row(`${taxText(returned.tax)} returned`, `-${money(returned.tax.amount)}`);
    }
    y -= 18;
    row(
      "Paid back to your Stripe balance when each fee was returned",
      money(returned.fee + (returned.tax?.amount ?? 0)),
    );
  }

  y -= 22;
  rule(y, rgb(0.8, 0.8, 0.8));

  // ── Total ─────────────────────────────────────────────────────────────
  y -= 18;
  draw("Amount due", left + 6, y, { size: 13, font: bold });
  draw(money(input.totalDue), right - 6, y, { size: 13, font: bold, align: "right" });

  // Terms of payment (8-4). Card fees need none: they are already paid.
  y -= 16;
  draw(
    input.totalDue > 0
      ? "Terms: cash-fare fees are due on receipt. Card-fare fees were paid at the time of each charge."
      : "Terms: nothing is payable. Card-fare fees were paid at the time of each charge.",
    left + 6,
    y,
    { size: 9, color: gray },
  );

  y -= 18;
  rule(y);

  // ── Payment instructions — omitted entirely if not yet configured ─────
  if (input.vellon.paymentInstructions) {
    y -= 20;
    draw("PAYMENT INSTRUCTIONS", left, y, { size: 9, color: gray });
    y = drawWrapped(page, input.vellon.paymentInstructions, left, y - 14, W, regular, 10, black);
  }

  // ── Footer ────────────────────────────────────────────────────────────
  rule(62);
  draw(`${vellonName} — monthly platform fee statement and invoice, Vellon Dispatch`, left, 50, {
    size: 8,
    color: gray,
  });

  return doc.save();
}

// 14 rather than 14.00. Deliberately the same one-liner as mgcj's
// send-ride-receipt: two documents in one system should print a rate
// identically. (A trailing-zero strip by regex is the trap here — it turns a
// 10% rate into "1".)
function formatRate(percent: number): string {
  return String(Number(percent.toFixed(2)));
}

// Simple word-wrap for the free-text payment-instructions field, since it can
// be arbitrarily long. Returns the y position after the last line drawn.
function drawWrapped(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
): number {
  const words = text.split(/\s+/);
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font, color });
      y -= size + 4;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color });
    y -= size + 4;
  }
  return y;
}
