// Human-facing application IDs such as HEX-PT-7KQ3XM.
//
// These are separate from the database's UUID primary key, which is never shown to applicants.
// The alphabet leaves out 0/O, 1/I/L, 5/S and U/V lookalikes so IDs read cleanly aloud.

export const PUBLIC_ID_ALPHABET = "2346789ABCDEFGHJKMNPQRTWXYZ";
export const PUBLIC_ID_PATTERN = /^HEX-PT-[2346789ABCDEFGHJKMNPQRTWXYZ]{6}$/;

export function generatePublicApplicationId(
  randomBytes: (count: number) => Uint8Array = (count) => crypto.getRandomValues(new Uint8Array(count)),
): string {
  const alphabet = PUBLIC_ID_ALPHABET;
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % alphabet.length);
  let id = "";
  while (id.length < 6) {
    for (const byte of randomBytes(16)) {
      if (byte < limit) id += alphabet[byte % alphabet.length];
      if (id.length === 6) break;
    }
  }
  return `HEX-PT-${id}`;
}
