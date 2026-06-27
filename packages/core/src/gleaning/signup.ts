export type GleaningSignupStatus = "confirmed" | "waitlisted" | "dropped";

export interface GleaningSignup {
  personId: string;
  status: GleaningSignupStatus;
  waitlistPosition?: number;
}

export interface ApplyGleaningSignupInput {
  volunteerMax: number;
  signups: GleaningSignup[];
  personId: string;
}

export type ApplyGleaningSignupResult =
  | { status: "confirmed"; existing?: true }
  | { status: "waitlisted"; waitlistPosition: number; existing?: true };

export function applyGleaningSignup(input: ApplyGleaningSignupInput): {
  signups: GleaningSignup[];
  result: ApplyGleaningSignupResult;
} {
  if (input.volunteerMax < 1) {
    throw new Error("volunteerMax must be at least 1");
  }

  const existing = input.signups.find(
    (signup) =>
      signup.personId === input.personId && signup.status !== "dropped",
  );
  if (existing?.status === "confirmed") {
    return {
      signups: input.signups,
      result: { status: "confirmed", existing: true },
    };
  }
  if (existing?.status === "waitlisted") {
    return {
      signups: input.signups,
      result: {
        status: "waitlisted",
        waitlistPosition: existing.waitlistPosition ?? 1,
        existing: true,
      },
    };
  }

  const counts = countGleaningSignups(input.signups);
  if (counts.confirmed < input.volunteerMax) {
    const signup: GleaningSignup = {
      personId: input.personId,
      status: "confirmed",
    };
    return {
      signups: [...input.signups, signup],
      result: { status: "confirmed" },
    };
  }

  const waitlistPosition = counts.waitlisted + 1;
  const signup: GleaningSignup = {
    personId: input.personId,
    status: "waitlisted",
    waitlistPosition,
  };
  return {
    signups: [...input.signups, signup],
    result: { status: "waitlisted", waitlistPosition },
  };
}

export function countGleaningSignups(signups: GleaningSignup[]): {
  confirmed: number;
  waitlisted: number;
  dropped: number;
} {
  return signups.reduce(
    (counts, signup) => {
      counts[signup.status] += 1;
      return counts;
    },
    { confirmed: 0, waitlisted: 0, dropped: 0 },
  );
}
