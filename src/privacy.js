// Mask long ID numbers before any text leaves our server.
// Aadhaar = 12 digits, UAN = 12 digits, bank accounts = 9-18 digits.
function maskIds(text) {
  if (!text) return text;
  return text.replace(/\b(\d[\d\s-]{7,20}\d)\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 9) return m; // dates, amounts etc.
    return 'X'.repeat(digits.length - 4) + digits.slice(-4);
  });
}

module.exports = { maskIds };
