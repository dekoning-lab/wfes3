# Population Projection

## Description

Population Projection carries an allele frequency distribution from one
population size into another across a single Wright-Fisher generation, and
writes the result in the format the other programs read through `--initial`. It
is a utility rather than a model: it answers no question about a process, it
prepares a starting state for the programs that do.

The other WFES3 programs take a population size as fixed for the duration of a
model, or change it at a regime boundary as part of a larger calculation. This
program exposes that boundary on its own. The step it applies is one row block
of the switching machinery, so a distribution produced here is the same object
those models would have carried across the same size change, and it can be fed
straight back into `wfes_single`, `time_dist`, `phase_type_dist` or any other
tool as that tool's starting distribution.

## Mathematical Model

The projection is the rectangular matrix whose rows are

    P(j | i) = Binomial(j; 2*N_target, psi(i, N_source, s, h, u, v))

where `psi` is the post-selection, post-mutation allele frequency produced by
state `i` in the starting population. A state `i` in the starting population
(0 to 2*N_source) therefore contributes a binomial sample of `2*N_target` draws
to the new population, taken at the frequency that selection, dominance and
mutation leave after one generation at the starting size.

Given a starting distribution `x` over the `2*N_source + 1` states, the reported
distribution over the `2*N_target + 1` states is `x` multiplied by that matrix,
renormalised. Selection, dominance and both mutation rates act during the
generation in which the size changes; they are not applied before or after it as
a separate step.

## Starting distribution

The starting distribution can be given in any of the three ways the rest of
WFES3 accepts:

- **Fixed p** — all mass on one allele count, between 1 and 2N-1 of the
  starting population.
- **Integrate over p** — the distribution of starting copy numbers a new
  mutation produces, truncated at the integration cutoff.
- **Custom distribution** — a CSV column of `2*N_source + 1` probabilities, one
  per state, in allele-count order.

## Output

The result is a probability distribution over allele counts 0 to 2*N_target in
the new population size. Copy and save write one probability per line in state
order, with no header and no index column, which is the form `--initial` reads.

The programs do not share one state space, so the file has to be written for the
program that will read it. Three shapes are offered, and the amount of
probability mass a trimmed shape leaves behind at the boundaries is reported
before it is written; the remainder is renormalised.

| Counts written | Values | Read by |
| --- | --- | --- |
| 0 to 2N | 2N+1 | `wfafs_deterministic`, `wfafs_stochastic` |
| 1 to 2N-1 | 2N-1 | `wfes_single`, `time_dist` |
| 0 to 2N-1 | 2N | `phase_type_dist` |

## Technical Notes

The computation runs `wfafs_deterministic` with two epochs of length zero. That
program applies each epoch's matrix for the number of generations given and, at
each epoch boundary, applies the rectangular block that changes the population
size. With both epoch lengths at zero the block between them is the only step
applied, so the result is one size-changing generation and nothing else.

`--alpha` trims probability mass from the tails of each matrix row, and each row
is renormalised afterwards. It controls the sparsity of the projection matrix,
and at its default of 1e-20 its effect on the reported distribution is far below
the precision printed.
