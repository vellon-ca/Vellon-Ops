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

export type InvoicePdfInput = {
  invoiceNumber: string;
  periodLabel: string; // e.g. "June 2026"
  issueDate: string; // pre-formatted, e.g. "July 18, 2026"
  companyName: string;
  billingAddress: string | null;
  cashFaresTotal: number;
  feePercent: number;
  rideCount: number;
  amountDue: number;
  vellon: {
    legalName: string | null;
    businessNumber: string | null;
    hstNumber: string | null;
    mailingAddress: string | null;
    paymentInstructions: string | null;
  };
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

  // ── Header ──────────────────────────────────────────────────────────
  draw(vellonName, left, y, { size: 18, font: bold });
  draw("INVOICE", right, y, { size: 20, font: bold, align: "right" });

  y -= 20;
  if (input.vellon.mailingAddress) {
    draw(input.vellon.mailingAddress, left, y, { size: 9, color: gray });
  }
  draw(input.invoiceNumber, right, y, { size: 10, color: gray, align: "right" });

  y -= 14;
  const regNumbers = [
    input.vellon.businessNumber ? `BN: ${input.vellon.businessNumber}` : null,
    input.vellon.hstNumber ? `HST Reg: ${input.vellon.hstNumber}` : null,
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

  y -= 24;
  draw(`Cash fares this period (${input.rideCount} ride${input.rideCount === 1 ? "" : "s"})`, left + 6, y, {
    size: 11,
  });
  draw(`$${input.cashFaresTotal.toFixed(2)}`, right - 6, y, { size: 11, align: "right" });

  y -= 20;
  draw(`Platform fee (${input.feePercent}%)`, left + 6, y, { size: 10, color: gray });
  draw(`$${input.amountDue.toFixed(2)}`, right - 6, y, { size: 10, color: gray, align: "right" });

  y -= 22;
  rule(y, rgb(0.8, 0.8, 0.8));

  // ── Total ─────────────────────────────────────────────────────────────
  y -= 18;
  draw("Amount due", left + 6, y, { size: 13, font: bold });
  draw(`$${input.amountDue.toFixed(2)}`, right - 6, y, { size: 13, font: bold, align: "right" });

  y -= 22;
  rule(y);

  // ── Payment instructions — omitted entirely if not yet configured ─────
  if (input.vellon.paymentInstructions) {
    y -= 20;
    draw("PAYMENT INSTRUCTIONS", left, y, { size: 9, color: gray });
    y = drawWrapped(page, input.vellon.paymentInstructions, left, y - 14, W, regular, 10, black);
  }

  // ── Footer ────────────────────────────────────────────────────────────
  rule(62);
  draw(`${vellonName} — platform fee invoice for cash rides via Vellon dispatch`, left, 50, {
    size: 8,
    color: gray,
  });

  return doc.save();
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
