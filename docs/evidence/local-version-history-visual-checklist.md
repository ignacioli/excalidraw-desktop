# Local Version History visual checklist

**Current gate**: Low-fidelity and high-fidelity APPROVED; production visual acceptance PENDING
**Low-fidelity owner approval date**: 2026-09-23
**High-fidelity owner approval date**: 2026-09-23

## Low-fidelity decision record

- [x] 360 px right-side History drawer approved.
- [x] 300 px retained only as cramped fallback.
- [x] Canvas remains the primary surface.
- [x] Preview and Restore remain directly visible.
- [x] Mark/Unmark and Delete version use an accessible vertical-ellipsis menu.
- [x] Current, selected, preview, and marked states do not rely on color alone.
- [x] Restore, Delete, and Discard recovery use confirmation.
- [x] External recovery is not automatically deleted before an explicit decision.
- [x] Keyboard focus trap and focus-return paths are represented and exercised in the prototype.
- [x] Loading, empty, pending, permission, resource, conflict, generic error, dark, cramped, and reduced-motion states are represented.
- [x] Review-only state navigator is not production UI.

## High-fidelity review

- [x] Penpot file/page identity verified before writes.
- [x] Light history list and readonly preview approved.
- [x] Dark history treatment and readonly-preview visual direction approved.
- [x] External recovery issue and confirmation flow approved.
- [x] Permission/resource/conflict/error states retain the approved low-fidelity hierarchy and high-fidelity semantic-token treatment.
- [x] 1280 × 760 geometry and text truncation approved.
- [x] 360 px default and 300 px cramped fallback approved visually.
- [x] More actions menu, focus behavior, destructive hierarchy, and vector icon treatment approved; final menu is 180 × 84 px.
- [x] High-fidelity Penpot archive frozen locally with manifest and SHA-256.

The approved Penpot page contains six necessary high-fidelity frames. The low-fidelity prototype remains the exhaustive interaction-state reference for loading, empty, permission, unavailable-resource, conflict, generic-error, delete-confirmation, focus-return, and reduced-motion behavior. Production rendering of those states remains in the package-level gate below.

## Production visual acceptance

- [ ] Exact macOS production package at 1280 × 760.
- [ ] Light and Dark.
- [ ] Current versus preview distinction.
- [ ] Error, conflict, pending, and external recovery.
- [ ] Visible keyboard focus and focus return.
- [ ] No clipped essential action or horizontal overflow.
- [ ] Reduced motion.
- [ ] Automated evidence, independent visual-review verdict, and product-owner decision recorded separately.
