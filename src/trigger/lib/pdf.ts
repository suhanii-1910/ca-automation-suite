import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function decryptPdf(
  pdfBase64: string,
  password?: string
): Promise<string> {
  if (!pdfBase64) {
    throw new Error("PDF data is required.");
  }

  const tempDir = await mkdtemp(
    path.join(tmpdir(), "ca-bank-statement-")
  );

  const inputPath = path.join(tempDir, "input.pdf");
  const outputPath = path.join(tempDir, "decrypted.pdf");

  try {
    // ---------------------------------------------------------
    // 1. Write Base64 PDF to temporary file
    // ---------------------------------------------------------

    await writeFile(
      inputPath,
      Buffer.from(pdfBase64, "base64")
    );

    // ---------------------------------------------------------
    // 2. Check whether PDF requires a password
    // ---------------------------------------------------------

    if (!password) {
      try {
        await execFileAsync("qpdf", [
          "--warning-exit-0",
          "--requires-password",
          inputPath,
        ]);

        // If qpdf exits normally here, the PDF does not
        // require a password.
        return pdfBase64;
      } catch (error: any) {
        const exitCode = error?.code;

        // Exit code 0:
        // No password required.
        if (exitCode === 0) {
          return pdfBase64;
        }

        // Exit code 2:
        // PDF is not encrypted.
        if (exitCode === 2) {
          return pdfBase64;
        }

        // Anything else is an actual qpdf problem.
        throw error;
      }
    }

    // ---------------------------------------------------------
    // 3. Password supplied → decrypt PDF
    // ---------------------------------------------------------

    try {
      await execFileAsync("qpdf", [
        `--password=${password}`,
        "--warning-exit-0",
        "--decrypt",
        inputPath,
        outputPath,
      ]);
    } catch (error: any) {
      const exitCode = error?.code;

      // Exit code 2 = actual qpdf error.
      // With an encrypted PDF, this normally means
      // the password is incorrect.
      if (exitCode === 2) {
        throw new Error("INVALID_PDF_PASSWORD");
      }

      // Any other unexpected qpdf error.
      throw new Error(
        `PDF_DECRYPT_FAILED: ${
          error?.stderr || error?.message || "Unknown qpdf error"
        }`
      );
    }

    // ---------------------------------------------------------
    // 4. Make sure decrypted file actually exists
    // ---------------------------------------------------------

    let decryptedBuffer: Buffer;

    try {
      decryptedBuffer = await readFile(outputPath);
    } catch {
      throw new Error(
        "PDF_DECRYPT_FAILED: qpdf did not create the decrypted PDF."
      );
    }

    // ---------------------------------------------------------
    // 5. Return decrypted PDF as Base64
    // ---------------------------------------------------------

    return decryptedBuffer.toString("base64");
  } finally {
    // ---------------------------------------------------------
    // 6. Always clean up temporary files
    // ---------------------------------------------------------

    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}