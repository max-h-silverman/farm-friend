"use client";

import { useState } from "react";
import { PhoneStep } from "./phone-step";

/**
 * F-072 / F-073 — pick a farm, and be routed by whether it already has a farmer.
 *
 * This replaces the farm list on VIGA's Google weekly-status form. The routing is the whole
 * point: the same list holds farms that need setting up and farms that are already on Farm
 * Friend, and a farmer should not have to know which they are.
 *
 * **A `<select>`, not a radio list.** VIGA's form shows 35 radio buttons, which is a long scroll
 * on a phone and gets longer every year. A select is one tap and searchable by typing on every
 * platform.
 *
 * The onboarded/claimable split is the server's answer, re-checked when anything is submitted —
 * a page held open while someone else onboards must not be able to write.
 */
export interface PickableFarm {
  farmId: string;
  farmName: string;
  onboarded: boolean;
}

export function FarmPicker({
  farms,
  basePath,
}: {
  farms: PickableFarm[];
  /**
   * Where a claimable farm's link points. Passed in rather than hard-coded because F-079 puts
   * this picker behind a secret path segment, and the onward link must carry that segment or
   * the farmer's next step 404s.
   */
  basePath: string;
}) {
  const [farmId, setFarmId] = useState("");
  const picked = farms.find((farm) => farm.farmId === farmId);

  return (
    <div className="farmer-farm-picker">
      <label className="farmer-field" htmlFor="farm-picker">
        <span className="farmer-field-label">Your farm</span>
        <select
          id="farm-picker"
          value={farmId}
          onChange={(event) => setFarmId(event.target.value)}
        >
          <option value="">Choose your farm…</option>
          {farms.map((farm) => (
            <option key={farm.farmId} value={farm.farmId}>
              {farm.farmName}
            </option>
          ))}
        </select>
      </label>

      {picked === undefined ? null : picked.onboarded ? (
        <PhoneStep farmId={picked.farmId} farmName={picked.farmName} />
      ) : (
        <p className="farmer-picker-next">
          <a
            className="farmer-primary-action"
            href={`${basePath}/${encodeURIComponent(picked.farmId)}`}
          >
            Set up {picked.farmName}
          </a>
        </p>
      )}
    </div>
  );
}
