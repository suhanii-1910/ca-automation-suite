import "dotenv/config";

import { google } from "googleapis";
import { tasks } from "@trigger.dev/sdk";
import type { parseBankStatement } from "../trigger/tasks/parse-bank-statement";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------
// PATHS
// ---------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const credentialsPath = path.resolve(
  __dirname,
  "../../credentials/google-drive-service-account.json"
);

// ---------------------------------------------------------
// GOOGLE DRIVE
// ---------------------------------------------------------

const credentials = JSON.parse(
  readFileSync(credentialsPath, "utf-8")
);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({
  version: "v3",
  auth,
});

// ---------------------------------------------------------
// FIND + TRIGGER BANK STATEMENT
// ---------------------------------------------------------

async function findAndTriggerBankStatement() {
  try {
    console.log("🔍 Scanning for bank statements in Google Drive...");

    // ---------------------------------------------------------
    // Find Bank Transactions folder
    // ---------------------------------------------------------

    let folderId: string | undefined;

    const folderRes = await drive.files.list({
      q:
        "name = 'Bank Transactions' " +
        "and mimeType = 'application/vnd.google-apps.folder' " +
        "and trashed = false",

      fields: "files(id, name)",
      pageSize: 1,
    });

    if (
      folderRes.data.files &&
      folderRes.data.files.length > 0
    ) {
      folderId = folderRes.data.files[0].id!;

      console.log(
        `📁 Found folder: Bank Transactions (${folderId})`
      );
    }

    // ---------------------------------------------------------
    // Find files
    // ---------------------------------------------------------

    const query = folderId
      ? `'${folderId}' in parents and trashed = false`
      : "trashed = false and (mimeType = 'application/pdf' or mimeType = 'text/csv')";

    const filesRes = await drive.files.list({
      q: query,
      fields: "files(id, name, mimeType)",
      pageSize: 20,
    });

    const files = filesRes.data.files ?? [];

    const statementFile = files.find(
      (file) =>
        file.mimeType === "application/pdf" ||
        file.mimeType === "text/csv" ||
        file.name?.toLowerCase().includes("bank") ||
        file.name?.toLowerCase().includes("statement")
    );

    // ---------------------------------------------------------
    // No file
    // ---------------------------------------------------------

    if (!statementFile || !statementFile.id) {
      console.log(
        "⚠️ No bank statement found."
      );
      return;
    }

    console.log(
      `📄 Found statement: ${statementFile.name} (${statementFile.mimeType})`
    );

    console.log("⬇️ Downloading statement...");

    // ---------------------------------------------------------
    // Download
    // ---------------------------------------------------------

    const download = await drive.files.get(
      {
        fileId: statementFile.id,
        alt: "media",
      },
      {
        responseType:
          statementFile.mimeType === "text/csv"
            ? "text"
            : "arraybuffer",
      }
    );

    // ---------------------------------------------------------
    // CSV
    // ---------------------------------------------------------

    if (
      statementFile.mimeType === "text/csv" ||
      statementFile.name?.toLowerCase().endsWith(".csv")
    ) {
      const payload = {
        rawCsvText: download.data as string,
        filename:
          statementFile.name ?? "statement.csv",
      };

      console.log(
        "⚡ Triggering parse-bank-statement task..."
      );

      const handle = await tasks.trigger<
        typeof parseBankStatement
      >(
        "parse-bank-statement",
        payload
      );

      console.log(
        "✅ parse-bank-statement triggered successfully!"
      );

      console.log(`🆔 Run ID: ${handle.id}`);

      return;
    }

    // ---------------------------------------------------------
    // PDF
    // ---------------------------------------------------------

    const buffer = Buffer.from(
      download.data as ArrayBuffer
    );

    const pdfBase64 = buffer.toString("base64");

    // ---------------------------------------------------------
    // Ask for password
    // ---------------------------------------------------------

    const rl = createInterface({
      input,
      output,
    });

    let pdfPassword: string | undefined;

    try {
      const enteredPassword = await rl.question(
        "🔐 Enter PDF password (leave blank if none): "
      );

      pdfPassword =
        enteredPassword.length > 0
          ? enteredPassword
          : undefined;
    } finally {
      rl.close();
    }

    // ---------------------------------------------------------
    // Create payload
    //
    // IMPORTANT:
    // We DO NOT decrypt here.
    //
    // parse-bank-statement will receive:
    //   1. Original PDF
    //   2. Password
    //
    // and decrypt it ONCE.
    // ---------------------------------------------------------

    const payload = {
      statementPdfBase64: pdfBase64,
      filename:
        statementFile.name ?? "statement.pdf",
      pdfPassword,
    };

    console.log(
      pdfPassword
        ? "🔐 PDF password supplied."
        : "📄 No PDF password supplied."
    );

    console.log(
      "⚡ Triggering parse-bank-statement task..."
    );

    const handle = await tasks.trigger<
      typeof parseBankStatement
    >(
      "parse-bank-statement",
      payload
    );

    console.log(
      "✅ parse-bank-statement triggered successfully!"
    );

    console.log(`🆔 Run ID: ${handle.id}`);

  } catch (err) {
    console.error(
      "❌ Bank statement watcher failed:",
      err
    );
  }
}

// ---------------------------------------------------------
// RUN
// ---------------------------------------------------------

findAndTriggerBankStatement();