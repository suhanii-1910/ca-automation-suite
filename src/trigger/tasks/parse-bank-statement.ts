import { task, logger } from "@trigger.dev/sdk";
import Papa from "papaparse";
import { z } from "zod";
import { google } from "googleapis";
import { extractResponseText, getGenaiClient } from "../lib/gemini";
import { resolveTaxRules, type TaxRules } from "../lib/tax-rules";
import { decryptPdf } from "../lib/pdf";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const transactionSchema = z.object({
  date: z.string().default(""),
  description: z.string().default(""),
  debit: z.number().nonnegative().default(0),
  credit: z.number().nonnegative().default(0),
  mappedTallyLedger: z.string().default("Unclassified"),
  auditFlags: z.array(z.string()).default([]),
  auditRiskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
});

export const bankStatementOutputSchema = z.object({
  transactions: z.array(transactionSchema),
  spreadsheetUrl: z.string().optional(),
});

export type Transaction = z.infer<typeof transactionSchema>;
export type BankStatementOutput = z.infer<typeof bankStatementOutputSchema>;

export const bankStatementPayloadSchema = z.object({
  statementPdfBase64: z.string().optional(),
  rawCsvText: z.string().optional(),
  filename: z.string().optional(),
  pdfPassword: z.string().optional(),
});

export type BankStatementPayload = z.infer<typeof bankStatementPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseCsvText(rawCsvText: string): Papa.ParseResult<Record<string, string>> {
  return Papa.parse<Record<string, string>>(rawCsvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
}

function pickColumn(row: Record<string, string>, candidates: string[]): string {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null) return row[c].trim();
  }
  return "";
}

function parseAmount(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[₹$,\s]/g, "").replace(/[()]/g, "-");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/**
 * Converts common Indian bank date formats to ISO-8601 (YYYY-MM-DD).
 *
 * Handled patterns:
 *   dd/mm/yyyy       →  2026-06-13
 *   dd-mm-yyyy       →  2026-06-13
 *   dd Mon yyyy      →  2026-06-13  (e.g. "13 Jun 2026")
 *   yyyy-mm-dd       →  passed through unchanged
 *   OLE serial int   →  2026-06-08  (Google Sheets / Excel numeric date,
 *                        e.g. 46181 — common when the bank CSV column has no
 *                        explicit text format and Sheets stores the raw number)
 *
 * Returns the original string on any parse failure so callers can decide
 * how to handle malformed dates.
 */
function normalizeDate(raw: string): string {
  if (!raw) return raw;
  const s = raw.trim();

  // Already ISO-8601 — fast path.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // OLE / Lotus date serial: a plain 5-digit integer in the range
  // roughly 40000–60000 (year 2009–2064). These appear when Google Sheets
  // or Excel stores a date cell as a number and CSV export omits formatting.
  //   Serial 1 = 1900-01-01, but OLE has an off-by-one: serial 60 is
  //   incorrectly treated as 1900-02-29, so serials ≥ 61 must subtract 1
  //   extra day (the standard correction applied by all spreadsheet apps).
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    if (serial >= 40000 && serial <= 60000) {
      const OLE_EPOCH = new Date(Date.UTC(1899, 11, 30)); // 1899-12-30
      const ms = OLE_EPOCH.getTime() + serial * 86_400_000;
      const d = new Date(ms);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  // dd/mm/yyyy or dd-mm-yyyy
  const dmySep = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmySep) {
    const [, dd, mm, yyyy] = dmySep;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  // dd Mon yyyy  (e.g. "13 Jun 2026", "01 January 2026")
  const monthNames: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const dMonY = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dMonY) {
    const [, dd, mon, yyyy] = dMonY;
    const mm = monthNames[mon.toLowerCase().slice(0, 3)];
    if (mm) return `${yyyy}-${mm}-${dd.padStart(2, "0")}`;
  }

  // Unrecognised — return as-is so callers can log/fallback.
  return s;
}

function normalizeRow(
  row: Record<string, string>
): { date: string; description: string; debit: number; credit: number } | null {
  const date = pickColumn(row, ["date", "txn_date", "transaction_date", "value_date"]);
  const description = pickColumn(row, [
    "description",
    "narration",
    "particulars",
    "details",
    "remark",
  ]);
  const debitRaw = pickColumn(row, ["debit", "withdrawal", "dr", "withdrawal_amt"]);
  const creditRaw = pickColumn(row, ["credit", "deposit", "cr", "deposit_amt"]);
  const amountRaw = pickColumn(row, ["amount"]);

  let debit = parseAmount(debitRaw);
  let credit = parseAmount(creditRaw);

  if (!debit && !credit && amountRaw) {
    debit = parseAmount(amountRaw);
  }

  if (!date && !description) return null;
  return {
    date: date ? normalizeDate(date) : "",
    description: description || "",
    debit,
    credit,
  };
}

// ---------------------------------------------------------------------------
// Audit engine — Indian statutory checks
// ---------------------------------------------------------------------------
export type AuditRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface AuditResult {
  auditFlags: string[];
  auditRiskLevel: AuditRiskLevel;
}

/**
 * Evaluates a transaction against the configured tax rules for the given
 * (or default) financial year. All thresholds, sections, and keywords are
 * sourced from `src/trigger/lib/tax-rules.ts` — edit that file to reflect
 * a new Finance Act; no changes needed here.
 *
 * Side effect: if the transaction matches a `lifestyleKeywords` token and
 * Gemini did not already classify it as "Proprietor Drawings", this
 * function reclassifies it (safety-net deterministic pass).
 */
export function evaluateTransactionAudit(
  t: Transaction,
  financialYear?: string
): AuditResult {
  const rules: TaxRules = resolveTaxRules(financialYear);
  const desc = (t.description || "").toLowerCase();
  const flags: string[] = [];
  const amount = t.debit > 0 ? t.debit : t.credit;

  // ---- Cash disallowance (default: Sec 40A(3), > ₹10,000) ----
  const isCashSpend =
    t.debit > rules.cashDisallowance.limit &&
    rules.cashDisallowance.keywords.some((tok) => desc.includes(tok));
  if (isCashSpend) {
    flags.push(
      `🔴 ${rules.cashDisallowance.section}: Cash payment > ₹${rules.cashDisallowance.limit.toLocaleString("en-IN")} (Tax Disallowance Risk)`
    );
  }

  // ---- Cash receipt penalty (default: Sec 269ST, ≥ ₹2,00,000) ----
  const isCashReceipt =
    t.credit >= rules.cashReceipt.limit &&
    rules.cashReceipt.keywords.some((tok) => desc.includes(tok));
  if (isCashReceipt) {
    flags.push(
      `🚨 ${rules.cashReceipt.section}: Cash receipt >= ₹${(rules.cashReceipt.limit / 100_000).toFixed(0)} Lakh (Penalty Risk)`
    );
  }

  // ---- TDS on contractors (default: Sec 194C, ≥ ₹30,000) ----
  const isTdsContractor =
    t.debit >= rules.tdsContractor.limit &&
    rules.tdsContractor.keywords.some((tok) => desc.includes(tok));
  if (isTdsContractor) {
    flags.push(
      `⚠️ Check TDS (${rules.tdsContractor.section} Applicability)`
    );
  }

  // ---- TDS on professionals (default: Sec 194J, ≥ ₹30,000) ----
  const isTdsProfessional =
    t.debit >= rules.tdsProfessional.limit &&
    rules.tdsProfessional.keywords.some((tok) => desc.includes(tok));
  if (isTdsProfessional) {
    flags.push(
      `⚠️ Check TDS (${rules.tdsProfessional.section} Applicability)`
    );
  }

  // ---- TDS on rent (default: Sec 194-I, ≥ ₹50,000, ledger = Office Rent) ----
  const isRentSpend =
    t.debit >= rules.tdsRent.limit &&
    (t.mappedTallyLedger || "").toLowerCase() ===
      rules.tdsRent.ledger.toLowerCase();
  if (isRentSpend) {
    flags.push(
      `⚠️ Check TDS (${rules.tdsRent.section} Applicability)`
    );
  }

  // ---- High-value round-sum (Tiered: ≥ ₹10L -> HIGH, ₹1L to < ₹10L -> MEDIUM) ----
  const isHighValue = amount >= rules.roundSumThreshold;
  const isRoundSum =
    amount > 0 && (amount % 10_000 === 0 || amount % 50_000 === 0);
  const hasInvoiceSignal = /\b(inv|gst|gstin|invoice|bill|receipt)\b/i.test(
    t.description
  );
  if (isHighValue && isRoundSum && !hasInvoiceSignal) {
    if (amount >= 1_000_000) {
      flags.push(
        `🚨 High-Value Round-Sum Transaction (₹${(amount / 100_000).toFixed(2)}L - Sec 269SS/269T Scrutiny Risk)`
      );
    } else {
      flags.push(
        `⚠️ High-Value Round-Sum Transaction (₹${(amount / 100_000).toFixed(2)}L)`
      );
    }
  }

  // ---- Lifestyle → Proprietor Drawings (safety net) ----
  const isLifestyle =
    t.mappedTallyLedger !== "Proprietor Drawings" &&
    t.debit > 0 &&
    rules.lifestyleKeywords.some((tok) => desc.includes(tok));
  if (isLifestyle) {
    t.mappedTallyLedger = "Proprietor Drawings";
    flags.push("ℹ️ Auto-reclassified to Proprietor Drawings (lifestyle spend)");
  }

  if (flags.length === 0) {
    flags.push("✅ Standard Business Txn");
  }

  // Risk level roll-up: any 🔴 / 🚨 → HIGH; any ⚠️ → MEDIUM; else LOW.
  let risk: AuditRiskLevel = "LOW";
  if (flags.some((f) => f.startsWith("🔴") || f.startsWith("🚨"))) {
    risk = "HIGH";
  } else if (flags.some((f) => f.startsWith("⚠️"))) {
    risk = "MEDIUM";
  }

  return { auditFlags: flags, auditRiskLevel: risk };
}

/**
 * Appends transactions to Google Sheets under 'Bank Transactions' tab
 */
async function appendTransactionsToGoogleSheet(
  spreadsheetId: string,
  transactions: Transaction[]
) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const tabName = "Bank Transactions";

  // 1. Ensure 'Bank Transactions' tab and headers exist (8-column schema)
  const EXPECTED_HEADER = [
    "STATUS",
    "DATE",
    "DESCRIPTION",
    "DEBIT (WITHDRAWAL)",
    "CREDIT (DEPOSIT)",
    "MAPPED TALLY LEDGER",
    "AUDIT CHECK",
    "AUDIT RISK LEVEL",
  ];

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetExists = meta.data.sheets?.some(
      (s) => s.properties?.title === tabName
    );

    if (!sheetExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: { title: tabName },
              },
            },
          ],
        },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!A1:H1`,
        valueInputOption: "RAW",
        requestBody: { values: [EXPECTED_HEADER] },
      });
    } else {
      // Idempotent header migration: if the existing header is missing the
      // AUDIT RISK LEVEL column (or otherwise mismatched), rewrite it.
      const headerRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A1:H1`,
      });
      const existing = (headerRes.data.values?.[0] ?? []).map((c) =>
        String(c).trim()
      );
      const matches = EXPECTED_HEADER.every((h, i) => existing[i] === h);
      if (!matches) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tabName}'!A1:H1`,
          valueInputOption: "RAW",
          requestBody: { values: [EXPECTED_HEADER] },
        });
      }
    }
  } catch (err) {
    logger.warn("Sheet setup warning:", { error: err });
  }

  // 2. Format rows (8 columns)
  const rows = transactions.map((t) => [
    "🟡 Pending Review",
    t.date,
    t.description,
    t.debit > 0 ? t.debit : "",
    t.credit > 0 ? t.credit : "",
    t.mappedTallyLedger,
    t.auditFlags.join("; "),
    t.auditRiskLevel,
  ]);

  // 3. Append to sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------
export const parseBankStatement = task({
  id: "parse-bank-statement",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: BankStatementPayload): Promise<BankStatementOutput> => {
    const safe = bankStatementPayloadSchema.parse(payload);
    if (!safe.rawCsvText && !safe.statementPdfBase64) {
      throw new Error("parse-bank-statement: provide rawCsvText or statementPdfBase64.");
    }
    logger.info("parse-bank-statement: start", {
      hasCsv: !!safe.rawCsvText,
      hasPdf: !!safe.statementPdfBase64,
      filename: safe.filename,
    });

    // ---------- 1. Pull raw rows ----------
    let rawRows: { date: string; description: string; debit: number; credit: number }[] = [];

    if (safe.rawCsvText) {
      const parsed = parseCsvText(safe.rawCsvText);
      if (parsed.errors.length) {
        logger.warn("parse-bank-statement: CSV parse warnings", {
          errors: parsed.errors.slice(0, 5),
        });
      }
      rawRows = parsed.data
        .map(normalizeRow)
        .filter((r): r is NonNullable<typeof r> => r !== null);
    } else {
      let pdfPart = safe.statementPdfBase64!.replace(
        /^data:[^;]+;base64,/,
        ""
      );

      try {
        logger.info("parse-bank-statement: checking PDF protection");
        pdfPart = await decryptPdf(pdfPart, safe.pdfPassword);
        logger.info("parse-bank-statement: PDF ready for Gemini");
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "PDF_PASSWORD_REQUIRED"
        ) {
          throw new Error(
            "PDF_PASSWORD_REQUIRED: This bank statement is password protected. Please provide the PDF password."
          );
        }

        if (
          error instanceof Error &&
          error.message === "INVALID_PDF_PASSWORD"
        ) {
          throw new Error(
            "INVALID_PDF_PASSWORD: The PDF password is incorrect."
          );
        }

        if (
          error instanceof Error &&
          error.message === "PDF_DECRYPTOR_UNAVAILABLE"
        ) {
          throw new Error(
            "PDF_DECRYPTOR_UNAVAILABLE: qpdf is required to decrypt password-protected bank statements. Install it locally (macOS: brew install qpdf) or deploy the configured Trigger worker image."
          );
        }

        if (
          error instanceof Error &&
          error.message === "PDF_DECRYPTION_FAILED"
        ) {
          throw new Error(
            "PDF_DECRYPTION_FAILED: qpdf could not decrypt this PDF. Check that the file is a valid, supported PDF."
          );
        }

        throw error;
      }

      const prompt = `Extract every transaction from this bank statement PDF.
Return JSON: { "rows": [{ "date": "YYYY-MM-DD", "description": "...", "debit": number, "credit": number }] }
Use 0 for missing debit/credit. ISO-8601 dates. Return ONLY JSON.`;

      const genai = getGenaiClient();
      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { data: pdfPart, mimeType: "application/pdf" } },
            ],
          },
        ],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const text = extractResponseText(response);
      const json = JSON.parse(text || "{}");
      const rows = Array.isArray(json.rows) ? json.rows : [];
      rawRows = rows
        .map((r: any) => ({
          date: String(r.date ?? ""),
          description: String(r.description ?? ""),
          debit: Number(r.debit ?? 0) || 0,
          credit: Number(r.credit ?? 0) || 0,
        }))
        .filter((r: { date: string; description: string }) => r.date || r.description);
    }

    if (!rawRows.length) {
      logger.info("parse-bank-statement: no rows detected");
      return { transactions: [] };
    }

    // ---------- 2. Categorize via Gemini (batched) ----------
    const BATCH_SIZE = 50;
    const genai = getGenaiClient();
    const out: Transaction[] = [];

    for (let i = 0; i < rawRows.length; i += BATCH_SIZE) {
      const batch = rawRows.slice(i, i + BATCH_SIZE);
      const prompt = `You are a Tally Prime ledger-mapping assistant for an Indian MSME / proprietorship.
Given the following array of bank transactions, return a JSON object with key "transactions" preserving the original order.
For each row, fill "mappedTallyLedger" with standard Tally ledger heads.

CLASSIFICATION RULES (strict):
1. PERSONAL / LIFESTYLE spends MUST be classified as "Proprietor Drawings" — these are not business expenses. Examples include but are not limited to:
   - Food delivery: Swiggy, Zomato, EatFit, Magicpin
   - Quick commerce / groceries for personal use: Blinkit, Zepto, Instamart, BigBasket (when personal)
   - Subscriptions / OTT: Netflix, Amazon Prime (personal), Hotstar, Spotify, YouTube Premium
   - Personal shopping / fashion: Amazon (retail, not Amazon Business), Myntra, Ajio, Flipkart (personal), Nykaa
   - Personal education: school fees, college fees, tuition, coaching classes
   - Personal medical: hospitals, clinics, pharmacy, Apollo, Medplus, diagnostic labs (personal)
   - Jewelry: Tanishq, Malabar, Joyalukkas, local jewelers (personal adornment)
   - Personal travel: MakeMyTrip, Goibibo, IRCTC, Ola, Uber, Rapido (personal), personal hotel bookings
2. STANDARD BUSINESS spends should map to canonical Tally heads:
   - "Office Rent" — rent paid to landlord for office/warehouse
   - "Salaries & Wages" — payroll, salary, bonus, incentive payouts to staff
   - "Bank Charges" — bank fees, NEFT/IMPS charges, SMS alerts, AMC on locker
   - "Professional Fees" — CA, CS, lawyer, advocate, consultancy fees
   - "Contractor Expense" — fabrication, civil works, maintenance contractors, freight
   - "Sales - Domestic" — receipts from Indian customers for goods/services
   - "Purchase - Domestic" — payments to Indian vendors for goods/services
   - "Telephone Expense" / "Internet Expense" — telecom, broadband, mobile bills (business)
   - "Fuel Expense" — petrol/diesel for vehicles, HPCL/IOCL/BPCL fuel cards (business)
   - "TDS Receivable" — TDS deducted on our receipts by customers
   - "GST Payable" — GST payments to government
   - "Interest Received" — interest credits from bank/FD
   - "Unclassified" — only when genuinely ambiguous (use sparingly)

Keep date & description exactly as given; round debit/credit to 2 decimals.

Bank transactions:
${JSON.stringify(batch, null, 2)}

Return ONLY JSON: { "transactions": [ { "date": "...", "description": "...", "debit": number, "credit": number, "mappedTallyLedger": "..." } ] }`;

      const response = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", temperature: 0.1 },
      });
      const text = extractResponseText(response);
      const json = JSON.parse(text || "{}");
      const txs = Array.isArray(json.transactions) ? json.transactions : [];

      for (const t of txs) {
        const parsed = transactionSchema.parse({
          date: t.date ? normalizeDate(String(t.date)) : "",
          description: t.description ?? "",
          debit: Number(t.debit ?? 0) || 0,
          credit: Number(t.credit ?? 0) || 0,
          mappedTallyLedger: t.mappedTallyLedger ?? "Unclassified",
          auditFlags: [],
          auditRiskLevel: "LOW" as const,
        });
        const audit = evaluateTransactionAudit(parsed);
        out.push({
          ...parsed,
          mappedTallyLedger: parsed.mappedTallyLedger,
          auditFlags: audit.auditFlags,
          auditRiskLevel: audit.auditRiskLevel,
        });
      }
    }

    // ---------- 3. Append to Google Sheets ----------
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (spreadsheetId && out.length > 0) {
      logger.info("parse-bank-statement: syncing to Google Sheets...", { spreadsheetId });
      await appendTransactionsToGoogleSheet(spreadsheetId, out);
      logger.info("parse-bank-statement: Google Sheets sync complete");
    }

    logger.info("parse-bank-statement: complete", { totalTransactions: out.length });
    return {
      transactions: out,
      spreadsheetUrl: spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        : undefined,
    };
  },
});