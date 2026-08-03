import { parseFarmBucksPolicy } from "./stand-fields";
import { stripContactDetails } from "./stand-csv";

export interface PublicListingSource {
  standName: string;
  sourceText: string;
}

export interface PublicListingDetails {
  description?: string;
  farmBucksAccepted?: boolean;
  farmBucksEligible?: true;
}

/** Prepare reviewed source prose for the public farm/listing columns. */
export function publicListingDetails(source: PublicListingSource): PublicListingDetails {
  const description = stripContactDetails(source.sourceText);
  const policy = parseFarmBucksPolicy(`${source.standName}\n${description}`);

  return {
    ...(description !== "" ? { description } : {}),
    ...(policy !== undefined
      ? {
          farmBucksAccepted: policy.accepted,
          farmBucksEligible: policy.eligible,
        }
      : {}),
  };
}
