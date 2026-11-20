# RightsDesk · Master build prompt

Build RightsDesk in the repository supplied with this pack. The product's first complete journey is the following.

An editor selects a chart and describes the intended edition and territory. The rights officer checks the seller identity, asset and terms. An authorized purchase obtains a seller-issued structured grant. The publication integration submits the exact planned use and receives its decision and required credit line. A later global republication triggers a fresh evaluation.

## Intake

Read repository instructions and inspect the current branch, HEAD, uncommitted work, existing architecture, locked dependencies, test commands and any ongoing implementation. Check [source baselines](SOURCES.md) before reusing upstream work. Record whether this is a dedicated greenfield project or an extension. For an existing implementation, trace each claimed capability from its real entry point before assigning completion. Preserve user changes.

## Build

Follow [the module index](MODULES.md). Drive changes from observable failing behavior. Implement actual domain rules, authorization, UI/API, storage and recovery. Use test doubles for deterministic fault injection and pair them with real local integration tests. Keep independent work moving when a partner dependency blocks one path. Expose each blocked external feature honestly in the UI and status ledger.

## Evidence and exit

Asset A revision 3 has hash H3. A signed grant permits one newsroom's India edition on web, editorial use, territory IN, named attribution, from 2030-01-01T00:00Z up to but excluding 2030-02-01T00:00Z. A Jan 20 controlled IN edition carrying the exact credit and H3 is allowed. A global edition is denied. A request lacking evidence of distribution controls is referred for review. Payment without the signed grant yields paid_awaiting_grant and no publish permit. At the expiry instant the old decision cannot authorize publication.

Show the normal workflow in a clean checkout, exercise failure and restart, and leave evidence tied to the exact tested revision. A recorded demo uses the running product and permitted inputs. Verify logs, screenshots and exports are redacted. Local building and testing begin when the owner invokes this prompt for the supplied target. Remote publishing, deployment, paid calls, account creation, signing and public submissions need action-specific authority. Use the owner’s existing grants when applicable.

After every module, and before yielding, update the [continuation records](DELIVERY.md). Tell the next agent what already works, what failed, the last command, and the first concrete operation to perform.
