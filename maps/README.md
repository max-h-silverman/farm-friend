# maps/ — initial VIGA listing reference input

The existing VIGA map/form export is reference input for a later validated, one-time seed utility.
It is not migration data and establishes no compatibility, lifecycle, claim, or provenance model.

The seed utility is deliberately not part of the initial database migration. When authorized, it
will validate and load farms, public sales locations, listing facts, and approval state against the
clean launch schema. One-time location validation belongs to that utility; there is no runtime
geocoder or permanent mapping-provider seam, and unresolved locations remain operator tasks.
