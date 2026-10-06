/// <reference lib="webworker" />
/**
 * Key generation Web Worker (cryptography WASM): builds an OpenSSH key pair
 * (Ed25519, ECDSA P-256/P-384, RSA 3072/4096), optionally passphrase-
 * encrypted, plus its public line and WASM warnings — so RSA keygen (up to
 * ~a minute) never freezes the page. Cancel = the client terminates this
 * worker. Imports the wasm-bindgen glue directly (own bundle).
 */
import init, * as crypto from "@/generated/wasm/cryptography/cryptography.js";
import type { SshKeygenRequest, SshKeygenResponse } from "@/scripts/wasm/keygen-protocol";

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = init().then(() => undefined);
  return ready;
}

function post(msg: SshKeygenResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function generate(req: SshKeygenRequest): { privateKey: string; publicKey: string; warnings: string[] } {
  const { passphrase: p, comment: c } = req;
  let privateKey: string;
  switch (req.keyType) {
    case "ed25519":
      privateKey = crypto.openssh_ed25519_private_key(crypto.ed25519_generate_keypair().slice(0, 32), c, p, null);
      break;
    case "ecdsa-p256":
      privateKey = crypto.openssh_ecdsa_p256_private_key(crypto.ecdsa_p256_generate_keypair().slice(0, 32), c, p, null);
      break;
    case "ecdsa-p384":
      privateKey = crypto.openssh_ecdsa_p384_private_key(crypto.ecdsa_p384_generate_keypair().slice(0, 48), c, p, null);
      break;
    case "rsa":
      privateKey = crypto.openssh_rsa_private_key_from_pkcs8(crypto.rsa_generate_private_key_pkcs8(req.rsaBits), c, p, null);
      break;
    default:
      throw new Error("unsupported key type");
  }
  const publicKey = crypto.openssh_private_key_to_public_key_line(privateKey, p, c);
  const warnings = crypto.openssh_private_key_warnings(privateKey, p);
  return { privateKey, publicKey, warnings };
}

self.addEventListener("message", async (ev: MessageEvent<SshKeygenRequest>) => {
  const req = ev.data;
  try {
    await ensureReady();
    post({ id: req.id, ok: true, ...generate(req) });
  } catch (e) {
    post({ id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
