import "server-only";

// Email body for the cash-invoice send — same visual language as mgcj-app's
// ride-receipt email (centered container, boxed total, muted detail table),
// so anything a company receives from Vellon looks like it's from one system.

export function buildInvoiceEmailHtml(params: {
  companyName: string;
  invoiceNumber: string;
  periodLabel: string;
  amountDue: number;
  cashFaresTotal: number;
  feePercent: number;
  rideCount: number;
  paymentInstructions: string | null;
}): string {
  const {
    companyName,
    invoiceNumber,
    periodLabel,
    amountDue,
    cashFaresTotal,
    feePercent,
    rideCount,
    paymentInstructions,
  } = params;

  return `
  <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
    <div style="text-align: center; padding: 24px 0;">
      <h1 style="font-size: 20px; margin: 0; color: #1a1a1a;">Vellon</h1>
      <p style="color: #6B7280; font-size: 13px; margin-top: 4px;">Platform fee invoice</p>
    </div>

    <p style="font-size: 14px; margin: 0 0 16px;">Hi ${companyName} team,</p>
    <p style="font-size: 14px; margin: 0 0 16px;">
      Attached is your platform fee invoice for cash rides in ${periodLabel}.
    </p>

    <div style="background: #f7f7f7; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">Amount due</p>
      <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a;">$${amountDue.toFixed(2)}</p>
      <p style="margin: 4px 0 0; font-size: 13px; color: #6B7280;">Invoice ${invoiceNumber}</p>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px; width: 140px;">Period</td>
        <td style="padding: 8px 0; font-size: 13px;">${periodLabel}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Cash fares total</td>
        <td style="padding: 8px 0; font-size: 13px;">$${cashFaresTotal.toFixed(2)} (${rideCount} ride${rideCount === 1 ? "" : "s"})</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Platform fee</td>
        <td style="padding: 8px 0; font-size: 13px;">${feePercent}%</td>
      </tr>
    </table>

    ${
      paymentInstructions
        ? `
    <div style="border: 1px solid #E5E7EB; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
      <p style="margin: 0 0 4px; font-size: 12px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.03em;">Payment instructions</p>
      <p style="margin: 0; font-size: 13px; white-space: pre-wrap;">${paymentInstructions}</p>
    </div>`
        : ""
    }

    <p style="font-size: 12px; color: #9CA3AF; text-align: center; margin-top: 24px;">
      Questions about this invoice? Just reply to this email.<br/>
      Vellon
    </p>
  </div>
  `;
}
