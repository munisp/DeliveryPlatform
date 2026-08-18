# Account Lifecycle UX Visual Check

## Signup screen — 2026-08-18

The production preview at `/signup` rendered the two-column public lifecycle layout without clipping. The form showed concise name guidance, keyboard-accessible information controls for work-email and password guidance, and the password-policy hint.

Entering `invalid-email` into the work-email field immediately rendered the inline message **“Enter a valid work email address.”** beneath the field. The error appeared in the form’s visible validation area and the submit path remained blocked by the client-side form contract. This visual check used local preview data only and did not send email or create an account.
