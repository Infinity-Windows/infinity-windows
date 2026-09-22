# Clock and unit-form usability

Small patch following a source audit by Claude, reviewed by Codex. Keeps Forge’s existing theme and mobile workflow. Clock controls are centered and640px wide on screens at least860px. Short confirmation dialogs retain their individual sizing. The existing focus-trap hook adds keyboard containment, Escape and return focus, without reopening the trap during one-second timer updates. Necessary and helpful unit-form labels share a consistent two-line minimum in multi-column rows; single-column identity fields stay compact.

No shift, break, payroll, role, offline queue or form-save logic changes. English/Spanish release notes apply to all crew roles. Existing backdrop dismissal remains; protecting unsaved text is a separate follow-up. Source audit suggestions were checked against actual callers rather than widened globally.

Validation: synthetic browser checks for phone/desktop geometry, focus across two timer ticks, Tab wrapping, Escape and returned focus; existing custom-work, lunch and leave flows. Unit suite and production build run separately. Browser viewport emulation does not prove physical-device input behavior.
