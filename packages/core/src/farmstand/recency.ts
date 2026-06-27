export interface InventoryRecencyInput {
  updatedAt: Date;
  now: Date;
  cadenceHours?: number;
}

export interface InventoryRecencyDescription {
  visible: true;
  pastCadence: boolean;
  ageHours: number;
  label: string;
}

export function describeInventoryRecency(
  input: InventoryRecencyInput,
): InventoryRecencyDescription {
  const ageHours = Math.max(
    0,
    Math.floor((input.now.getTime() - input.updatedAt.getTime()) / 3_600_000),
  );
  const pastCadence =
    input.cadenceHours === undefined ? false : ageHours > input.cadenceHours;
  const base = `updated ${formatAge(ageHours)} ago`;

  return {
    visible: true,
    pastCadence,
    ageHours,
    label: pastCadence
      ? `${base}, older than this stand's usual update cadence`
      : base,
  };
}

function formatAge(ageHours: number): string {
  if (ageHours < 1) return "less than 1 hour";
  if (ageHours === 1) return "1 hour";
  if (ageHours < 48) return `${ageHours} hours`;

  const days = Math.floor(ageHours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}
