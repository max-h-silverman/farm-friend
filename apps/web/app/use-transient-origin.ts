"use client";

import { useCallback, useState } from "react";
import { isPlausibleOrigin, type PublicCoordinates } from "@farm-friend/core/proximity";

// Transient browser geolocation (F-017).
//
// "Transient" is the load-bearing word and it is enforced by WHERE this lives: the position
// is React state in the customer's own tab. It is never written to localStorage, never sent
// in a request, never logged, and never reaches a server, a database, or a model — because
// there is no code path here that could carry it anywhere. When the tab closes it is gone.
//
// Permission is requested only when the customer presses the button. A page that prompts on
// load trains people to dismiss the prompt, and the map is fully usable without it.

export type OriginState =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "ready"; origin: PublicCoordinates }
  /** Declined, unavailable, timed out, or implausible — all handled the same way. */
  | { status: "unavailable"; reason: string };

export function useTransientOrigin(): {
  state: OriginState;
  request: () => void;
  clear: () => void;
} {
  const [state, setState] = useState<OriginState>({ status: "idle" });

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.geolocation === undefined) {
      setState({
        status: "unavailable",
        reason: "This browser cannot share a location.",
      });
      return;
    }

    setState({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const origin = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        // The browser is an untrusted input like any other. A malfunctioning or spoofed
        // Geolocation API must not put NaN into a distance the page renders as a fact.
        if (!isPlausibleOrigin(origin)) {
          setState({
            status: "unavailable",
            reason: "Your device reported a location we could not use.",
          });
          return;
        }
        setState({ status: "ready", origin });
      },
      (error) => {
        setState({
          status: "unavailable",
          reason:
            error.code === error.PERMISSION_DENIED
              ? "Location is off. The full map is below."
              : "We could not get your location. The full map is below.",
        });
      },
      // No high-accuracy request: sorting a handful of island stands by approximate
      // distance does not need a GPS fix, and asking for one costs battery and time.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  const clear = useCallback(() => setState({ status: "idle" }), []);

  return { state, request, clear };
}
