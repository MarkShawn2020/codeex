export const requiredPrivacyUsageDescriptionKeys = [
  'NSMicrophoneUsageDescription',
  'NSCameraUsageDescription',
];

export function privacyUsageDescriptions(info) {
  return Object.fromEntries(
    Object.entries(info).filter(
      ([key, value]) =>
        /^NS[A-Za-z0-9]+UsageDescription$/.test(key) &&
        typeof value === 'string' &&
        value.trim().length > 0,
    ),
  );
}

export function assertRequiredPrivacyUsageDescriptions(info, label) {
  const missing = requiredPrivacyUsageDescriptionKeys.filter(
    (key) => typeof info[key] !== 'string' || info[key].trim().length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`${label} is missing privacy usage descriptions: ${missing.join(', ')}`);
  }
}

export function hasMatchingPrivacyUsageDescriptions(expected, actualInfo) {
  const actual = privacyUsageDescriptions(actualInfo);
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
