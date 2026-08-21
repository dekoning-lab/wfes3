# WFES Mode Naming Map

This document maps the new user-friendly frontend mode names to the backend CLI parameter names.

## WFES Single Modes

| Frontend Name | Backend Parameter | Description |
|--------------|-------------------|-------------|
| Standard Wright-Fisher | `--absorption` | Extinction and fixation states are treated as absorbing |
| Substitution Model | `--fixation` | Only fixation is treated as absorbing to compute properties of the substitution rate |
| Sojourn Times | `--fundamental` | Compute sojourn times including conditional on absorbing state |
| Establishment Properties | `--establishment` | Compute times and probabilities to allele establishment |
| Allele Age | `--allele-age` | Direct computations of the moments of allele age in any Wright-Fisher model |
| Non-Absorbing Model | `--non-absorbing` | Compute the full transition matrix treating all states as transient |
| Equilibrium Distribution | `--equilibrium` | Compute the stationary distribution of allele frequencies treating all states as transient |

## Frontend Display Order
1. Standard Wright-Fisher
2. Substitution Model  
3. Sojourn Times
4. Establishment Properties
5. Allele Age
6. Non-Absorbing Model
7. Equilibrium Distribution

## Implementation Notes

### Frontend (React/TypeScript)
- Mode values in state still use backend names: `'absorption' | 'fixation' | 'fundamental' | 'establishment' | 'alleleAge' | 'nonAbsorbing' | 'equilibrium'`
- Display names and descriptions are shown in the UI
- When sending to backend, the mode value is mapped to the corresponding CLI parameter

### Backend (C++)
- No changes needed currently
- Future work: Update CLI to accept both old and new parameter names for backwards compatibility

## WFES Sweep
- Only supports "Substitution Model" (`--fixation`) mode currently