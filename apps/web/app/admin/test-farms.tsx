"use client";

import { useState } from "react";
import { AdminRecoveryError } from "./admin-shell";

// F-074's operator surface: which farms are fake, and which phones may see them.
//
// Two lists in one component because they are one job — "set up a rehearsal" — and splitting
// them would make an operator hold the connection between them in their head. Neither list is
// authorization: both post to routes that re-check the session server-side.

export interface TestFarmRow {
  farmId: string;
  name: string;
  isTestFarm: boolean;
}

export interface TestPhoneRow {
  id: string;
  lastFour: string;
}

const FAILED = "That change did not go through. Reload and try again.";

export function TestFarms({
  farms,
  phones,
}: {
  farms: TestFarmRow[];
  phones: TestPhoneRow[];
}) {
  const [farmRows, setFarmRows] = useState(farms);
  const [phoneRows, setPhoneRows] = useState(phones);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");

  const testFarms = farmRows.filter((row) => row.isTestFarm);
  const realFarms = farmRows.filter((row) => !row.isTestFarm);

  function begin(key: string) {
    setPending(key);
    setError(null);
    setSessionExpired(false);
  }

  /** One failure path for both lists, so a 403 can never read as an ordinary error. */
  function handleFailure(status: number, message: string = FAILED) {
    if (status === 403) setSessionExpired(true);
    else setError(message);
  }

  async function setTestFarm(farmId: string, isTestFarm: boolean) {
    begin(farmId);
    try {
      const response = await fetch("/api/admin/farms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          farmId,
          action: isTestFarm ? "mark_test" : "unmark_test",
        }),
      });
      if (!response.ok) {
        handleFailure(response.status);
        return;
      }
      setFarmRows((current) =>
        current.map((row) => (row.farmId === farmId ? { ...row, isTestFarm } : row)),
      );
    } catch {
      setError(FAILED);
    } finally {
      setPending(null);
    }
  }

  async function addPhone(event: React.FormEvent) {
    event.preventDefault();
    const phone = phoneInput.trim();
    if (phone === "") return;
    begin("add-phone");
    try {
      const response = await fetch("/api/admin/test-farm-phones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", phone }),
      });
      if (!response.ok) {
        // Two failures an operator can actually act on get their own words. Everything else
        // gets the generic message, because guessing at a cause is worse than not saying.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        handleFailure(
          response.status,
          body.error === "invalid_phone"
            ? "That does not look like a phone number. Use a 10-digit US number."
            : response.status === 409
              ? "That number is already on the list."
              : FAILED,
        );
        return;
      }
      // The response deliberately carries no hash and no number, so the new row is rendered
      // from what the operator typed. It is refreshed from the database on the next load.
      setPhoneRows((current) => [
        { id: `pending-${phone}`, lastFour: phone.replace(/\D/g, "").slice(-4) },
        ...current,
      ]);
      setPhoneInput("");
    } catch {
      setError(FAILED);
    } finally {
      setPending(null);
    }
  }

  async function removePhone(id: string) {
    begin(id);
    try {
      const response = await fetch("/api/admin/test-farm-phones", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove", id }),
      });
      if (!response.ok) {
        handleFailure(response.status);
        return;
      }
      setPhoneRows((current) => current.filter((row) => row.id !== id));
    } catch {
      setError(FAILED);
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      {error !== null && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {sessionExpired && (
        <AdminRecoveryError>Your session expired before the change was saved.</AdminRecoveryError>
      )}

      <p className="admin-note">
        A test farm is hidden from the island map and from customer texts. You can see one by
        adding <code>?hidden=true</code> to the map address, or by texting from a number on the
        list below. Anyone who knows that web address can see test farms, so never use this to
        hide a real farm.
      </p>

      <h3>Test farms ({testFarms.length})</h3>
      {testFarms.length === 0 ? (
        <p className="admin-empty-state">No test farms. Customers see every farm.</p>
      ) : (
        <ul className="admin-farms">
          {testFarms.map((row) => (
            <li key={row.farmId} className="admin-farm">
              <div>
                <h4>{row.name}</h4>
                <p className="admin-unapproved">Hidden from customers</p>
              </div>
              <button
                type="button"
                disabled={pending === row.farmId}
                onClick={() => void setTestFarm(row.farmId, false)}
              >
                {pending === row.farmId ? "Saving…" : "Make it a real farm"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <details className="admin-secondary-disclosure">
        <summary>Mark a farm as a test farm ({realFarms.length} real farms)</summary>
        <ul className="admin-farms">
          {realFarms.map((row) => (
            <li key={row.farmId} className="admin-farm">
              <div>
                <h4>{row.name}</h4>
              </div>
              <button
                type="button"
                disabled={pending === row.farmId}
                onClick={() => void setTestFarm(row.farmId, true)}
              >
                {pending === row.farmId ? "Saving…" : "Hide as a test farm"}
              </button>
            </li>
          ))}
        </ul>
      </details>

      <h3>Phones that can see test farms ({phoneRows.length})</h3>
      <p className="admin-note">
        A number on this list sees test farms in its text replies. It gets no other access — it
        cannot publish, approve, or read anything a normal number cannot.
      </p>
      <form className="admin-inline-form" onSubmit={(event) => void addPhone(event)}>
        <label htmlFor="test-farm-phone">Phone number</label>
        <input
          id="test-farm-phone"
          name="phone"
          type="tel"
          autoComplete="off"
          placeholder="(206) 555-0139"
          value={phoneInput}
          onChange={(event) => setPhoneInput(event.target.value)}
        />
        <button type="submit" disabled={pending === "add-phone" || phoneInput.trim() === ""}>
          {pending === "add-phone" ? "Saving…" : "Add number"}
        </button>
      </form>
      {phoneRows.length === 0 ? (
        <p className="admin-empty-state">No numbers yet. Test farms are web-only for now.</p>
      ) : (
        <ul className="admin-farms">
          {phoneRows.map((row) => (
            <li key={row.id} className="admin-farm">
              {/*
                The last four digits and nothing else — the same masked form every other admin
                surface shows. It identifies a row to a person, never a subscriber.
              */}
              <div>
                <h4>{`(•••) •••-${row.lastFour}`}</h4>
              </div>
              <button
                type="button"
                disabled={pending === row.id}
                onClick={() => void removePhone(row.id)}
              >
                {pending === row.id ? "Saving…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
