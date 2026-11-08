const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const lowercase = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const alphabet = uppercase + lowercase + digits;

/** Generate locally with Web Crypto; never substitute a weaker random source. */
export function generatePassword(): string {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function")
    throw new Error("当前浏览器无法安全生成密码，请手动填写或使用密码管理器。");

  const bytes = new Uint8Array(64);
  let cursor = bytes.length;
  const randomIndex = (bound: number): number => {
    const limit = 256 - (256 % bound);
    let value: number;
    do {
      if (cursor === bytes.length) {
        source.getRandomValues(bytes);
        cursor = 0;
      }
      value = bytes[cursor++];
    } while (value >= limit);
    return value % bound;
  };

  const characters = [
    uppercase[randomIndex(uppercase.length)],
    lowercase[randomIndex(lowercase.length)],
    digits[randomIndex(digits.length)],
  ];
  while (characters.length < 32) characters.push(alphabet[randomIndex(alphabet.length)]);
  // Shuffle the required character classes so they have no fixed positions.
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [characters[index], characters[other]] = [characters[other], characters[index]];
  }
  return characters.join("");
}
