/**
 * OpenSSH Keys tool helpers (pure, unit-tested in test/crypto-tools.test.ts):
 * key-text format sniffing for Import/Convert, RSA modulus size selection
 * (algorithm "rsa-4096" must yield 4096 bits unless the size select
 * overrides it), and mapping well-known WASM error strings to locale keys.
 */
export type SshInputKind =
  | "empty"
  | "openssh-public"
  | "openssh-private"
  | "spki-public"
  | "pkcs8-private"
  | "unknown";

/** Sniff the pasted/loaded key format (legacy rules + ECDSA public lines). */
export function guessSshInput(text: string): SshInputKind {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  // ECDSA public lines start with "ecdsa-sha2-" — legacy only checked "ssh-".
  if (trimmed.startsWith("ssh-") || trimmed.startsWith("ecdsa-sha2-")) return "openssh-public";
  if (trimmed.includes("BEGIN OPENSSH PRIVATE KEY")) return "openssh-private";
  if (trimmed.includes("BEGIN PUBLIC KEY")) return "spki-public";
  if (trimmed.includes("BEGIN PRIVATE KEY") || trimmed.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
    return "pkcs8-private";
  }
  return "unknown";
}

export const RSA_ALLOWED_BITS = [3072, 4096] as const;

/**
 * RSA modulus size for generation: an explicit key-size choice wins,
 * otherwise the size encoded in the algorithm value (`rsa-4096`), else 3072.
 */
export function rsaBits(algorithm: string, keySize: string): number {
  const explicit = Number.parseInt(keySize, 10);
  if ((RSA_ALLOWED_BITS as readonly number[]).includes(explicit)) return explicit;
  const fromAlg = Number.parseInt(algorithm.replace(/^rsa-?/, ""), 10);
  if ((RSA_ALLOWED_BITS as readonly number[]).includes(fromAlg)) return fromAlg;
  return 3072;
}

/** Locale key for well-known WASM error messages, or null for "show raw". */
export function sshErrorKey(message: string): "ErrorPassphraseRequired" | "ErrorWrongPassphrase" | null {
  const m = message.toLowerCase();
  if (m.includes("passphrase required")) return "ErrorPassphraseRequired";
  if (m.includes("invalid passphrase") || m.includes("decrypt failed")) return "ErrorWrongPassphrase";
  return null;
}
