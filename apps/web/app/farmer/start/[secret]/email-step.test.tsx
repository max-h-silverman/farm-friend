// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmailStep } from "./email-step";

/**
 * The verification step's fields are what a farmer meets before they have any account, on a
 * phone, often outdoors. These assert the accessible name specifically: a placeholder LOOKS
 * like a label but is not one — it is not reliably announced, and it vanishes the moment
 * typing starts. `getByLabelText` passes only on a real accessible name.
 */
describe("EmailStep fields", () => {
  function renderStep() {
    render(<EmailStep farmId="farm-1" farmName="Plum Forest Farm" onVerified={() => {}} />);
  }

  it("gives the email box an accessible name, not just a placeholder", () => {
    renderStep();
    const email = screen.getByLabelText(/email address/i);
    expect(email).toBeTruthy();
    expect((email as HTMLInputElement).type).toBe("email");
  });

  it("keeps the email box's autofill and keyboard hints for a phone", () => {
    renderStep();
    const email = screen.getByLabelText(/email address/i) as HTMLInputElement;
    expect(email.getAttribute("autocomplete")).toBe("email");
  });

  it("names the farm so the farmer knows which listing they are claiming", () => {
    renderStep();
    expect(screen.getByText(/Plum Forest Farm/)).toBeTruthy();
  });
});
