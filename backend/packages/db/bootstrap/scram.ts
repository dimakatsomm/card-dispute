import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 4096;

const hmac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

// Hashing client-side keeps plaintext passwords out of server logs (log_statement, error CONTEXT lines).
export const scramVerifier = (password: string, salt: Buffer = randomBytes(16)): string => {
  const salted = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
};
