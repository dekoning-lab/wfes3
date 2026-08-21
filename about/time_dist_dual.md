# Time Distribution Dual

## Description

Time Distribution Dual computes the distribution of the time to absorption
starting from a population with no copies of the allele, so the reported time
includes the wait for a mutation to arise as well as the subsequent segregation.
`time_dist` starts from an allele already present and reports only the second
part; the difference between the two is the waiting time.

Which of the two applies depends on the question. If the waiting term dominates,
the substitution rate is set by the mutation rate rather than by the dynamics of
the segregating allele, which is the neutral expectation and the assumption
behind mutation-limited models of adaptation. Computing both distributions
exactly shows when that assumption holds for a given set of parameters instead
of requiring it in advance.

## Mathematical Model

The model consists of two phases:

### Phase 1: Mutation Waiting Time
Starting from 0 copies, waiting for the first mutation with rate 2Nv:
$$P(T_{mut} = t) = 2Nv \, e^{-2Nvt}$$

### Phase 2: Absorption Process  
Once mutation occurs, standard Wright-Fisher dynamics apply with conditional time distributions for extinction and fixation.

### Combined Distribution

The total time distribution is the convolution:
$$f_{total}(t) = \int_0^t f_{mut}(\tau) \, f_{abs}(t-\tau) \, d\tau$$

Where:
- f_mut: Exponential distribution for mutation arrival
- f_abs: Phase-type distribution for absorption

### Key Statistics

- **P_ext**: Probability of extinction after mutation
- **P_fix**: Probability of fixation after mutation
- **Sojourn_12**: Expected time from 1 to 2 copies (establishment indicator)
- **E[T_total]**: Expected total time including mutation wait

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size

### Model Parameters  
- `-s, --selection <float>`: Selection coefficient (default: 0)
- `-h, --dominance <float>`: Dominance coefficient (default: 0.5)
- `-u, --backward-mu <float>`: Backward mutation rate (default: 1e-9)
- `-v, --forward-mu <float>`: Forward mutation rate (must be > 0)

### Distribution Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused outright, with no override flag to bypass that check. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 2N probabilities over allele counts 0..2N-1. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-b, --block-size <int>`: Block size for computation (default: 100)
- `-d, --distribution-cutoff <float>`: Stop when CDF reaches this value (default: 0.99999)
- `-m, --max-t <int>`: Maximum time to compute (default: 1000000)

### Computational Parameters
- `--no-recurrent-mu`: Disable recurrent mutation after first occurrence
- `--num-threads <int>`: Number of threads
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q`: Write transition matrix
- `--output-R`: Write absorption matrix
- `--output-P`: Write time distribution
- `--json`: Output in JSON format

## Output Format

### Standard Output
Tab-delimited columns:
```
t    P_ext_1    P_fix_1    Sojourn_12
0    0          0          0
1    5.2e-7     3.1e-8     1.5e-5
2    1.0e-6     6.2e-8     3.0e-5
...
```

Where:
- t: Time since starting with 0 copies
- P_ext_1: Probability density of extinction at time t
- P_fix_1: Probability density of fixation at time t  
- Sojourn_12: Expected sojourn time from 1 to 2 copies

### JSON Output
```json
{
  "parameters": {
    "N": 1000,
    "s": 0.01,
    "h": 0.5,
    "u": 1e-9,
    "v": 1e-8,
    "alpha": 1e-20
  },
  "statistics": {
    "E_mut": 50000,
    "E_ext_post_mut": 3960,
    "E_fix_post_mut": 5020,
    "E_total_ext": 53960,
    "E_total_fix": 55020,
    "P_ext": 0.9801,
    "P_fix": 0.0199
  },
  "distribution": {
    "time": [0, 1, 2, ...],
    "P_ext_1": [0, 5.2e-7, 1.0e-6, ...],
    "P_fix_1": [0, 3.1e-8, 6.2e-8, ...],
    "Sojourn_12": [0, 1.5e-5, 3.0e-5, ...]
  },
  "execution_time": "15.3s"
}
```

## Usage Examples

### Basic dual distribution
```bash
time_dist_dual -N 1000 -v 1e-8 -s 0.01
```

### Neutral with high mutation rate
```bash
time_dist_dual -N 10000 -v 1e-6 -u 1e-7
```

### Deleterious to beneficial transition
```bash
time_dist_dual -N 5000 -v 1e-7 -s 0.01 -h 0.2
```

### Extended time range for slow processes
```bash
time_dist_dual -N 10000 -v 1e-9 -s 0.001 -m 100000000 -d 0.999999
```

## Technical Notes

1. **Two-Phase Calculation**: Separates mutation waiting from segregation dynamics
2. **Convolution Method**: Efficient numerical convolution for combined distribution
3. **Starting State**: Always begins with 0 copies (empty population)
4. **Mutation Requirement**: Forward mutation rate v must be positive
5. **Memory Efficiency**: Stores only essential distribution points

## Biological Interpretation

This model starts from a population with no copies of the allele, so the reported
time includes the wait for a mutation to arise as well as the time to absorption
once it has. That is the relevant timescale when adaptation is mutation-limited:
if the waiting term dominates, the substitution rate is set by the mutation rate
rather than by the dynamics of the segregating allele, which is the neutral
expectation.

Where a copy is already segregating, time_dist is the appropriate program; the
difference between the two is exactly the waiting term.

## Comparison with Standard time_dist

- **time_dist**: Assumes mutation already present (i ≥ 1)
- **time_dist_dual**: Includes mutation waiting time (i = 0)
- Use time_dist when modeling segregating variation
- Use time_dist_dual when modeling the complete substitution process