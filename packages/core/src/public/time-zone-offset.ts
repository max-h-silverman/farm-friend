/** The UTC offset in effect at one instant, including daylight-saving transitions. */
export function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((candidate) => candidate.type === "timeZoneName")?.value;
  const match = /^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/.exec(part ?? "");
  if (match === null) throw new RangeError(`cannot resolve UTC offset for ${timeZone}`);
  if (match.groups?.sign === undefined) return 0;
  const magnitude = Number(match.groups.hours) * 60 + Number(match.groups.minutes);
  return match.groups.sign === "+" ? magnitude : -magnitude;
}
