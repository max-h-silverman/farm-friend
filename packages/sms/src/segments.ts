export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SmsSegmentEstimate {
  encoding: SmsEncoding;
  /** User-visible Unicode code points, rather than JavaScript UTF-16 code units. */
  characterCount: number;
  /** GSM-7 septets or UCS-2/UTF-16 code units used for segment calculation. */
  encodingUnitCount: number;
  segmentCount: number;
}

const GSM_7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
      'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);

// Characters in the GSM-7 extension table consume an escape plus the character: two septets.
const GSM_7_EXTENSION = new Set(["\f", "^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

/**
 * Replace only typographic Unicode characters with unambiguous GSM-7 equivalents. This is
 * intentionally not a general transliterator: names, addresses, emoji, and meaningful Unicode
 * content must survive unchanged.
 */
export function normalizeAvoidableSmsUnicode(message: string): string {
  return message
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/\u2026/g, "...");
}

/** Estimate the encoding and carrier-billable segment count for an SMS body. */
export function estimateSmsSegments(message: string): SmsSegmentEstimate {
  const characters = Array.from(message);
  let gsmSeptets = 0;

  for (const character of characters) {
    if (GSM_7_BASIC.has(character)) {
      gsmSeptets += 1;
    } else if (GSM_7_EXTENSION.has(character)) {
      gsmSeptets += 2;
    } else {
      const encodingUnitCount = message.length;
      return {
        encoding: "UCS-2",
        characterCount: characters.length,
        encodingUnitCount,
        segmentCount:
          encodingUnitCount === 0
            ? 0
            : encodingUnitCount <= 70
              ? 1
              : Math.ceil(encodingUnitCount / 67),
      };
    }
  }

  return {
    encoding: "GSM-7",
    characterCount: characters.length,
    encodingUnitCount: gsmSeptets,
    segmentCount: gsmSeptets === 0 ? 0 : gsmSeptets <= 160 ? 1 : Math.ceil(gsmSeptets / 153),
  };
}
