# WFES Sweep

## Description

WFES Sweep computes the substitution rate when adaptation draws on variation
already segregating in the population. The model has two regimes: variation
accumulates under the first, which is neutral or deleterious, and then selection
acts under the second. It is a specialisation of the switching machinery in
`wfes_switching`, and reports what that specialisation is for: the expected time
to substitution, split into the wait under the pre-adaptive regime and the
duration of the sweep itself.

Standard treatments of adaptive substitution are mutation-limited: a new
beneficial mutation arises and sweeps, and the waiting time for that mutation
dominates. Adaptation from standing variation is faster, and this program
computes the difference. Most treatments assume the pre-adaptive regime has
reached its equilibrium frequency distribution. Here it need not have, so the
standing variation available when selection begins reflects how long the
pre-adaptive regime actually lasted.

## Mathematical Model

The model consists of two Wright-Fisher components:

1. **Pre-adaptive phase**: Non-absorbing model with selection coefficient s₁ ≤ 0
2. **Adaptive phase**: Fixation-only model with selection coefficient s₂ > 0

The transition between phases occurs at rate λ = 1/τ, where τ is the expected time in the pre-adaptive phase.

### Transition Matrix Structure

The combined model has block structure:
$$P = \begin{pmatrix}
Q_1 & \Gamma_{12} & R_1 \\
\Gamma_{21} & Q_2 & R_2 \\
0 & 0 & I
\end{pmatrix}$$

Where:
- Q₁, Q₂: Transition matrices within each phase
- Γ₁₂, Γ₂₁: Phase transition matrices  
- R₁, R₂: Absorption matrices (only R₂ ≠ 0)

### Key Calculations

**Time between fixations:**
$$T_{b.fix} = \sum_j N(0,j)$$

**Substitution rate:**
$$R = \frac{1}{T_{b.fix}}$$

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size (constant across phases)
- `-s, --selection <float>,<float>`: Selection coefficients for pre-adaptive and adaptive phases
- `-L, --lambda <float>`: Rate of transition from pre-adaptive to adaptive phase

### Optional Parameters
- `-h, --dominance <float>,<float>`: Dominance coefficients (default: 0.5,0.5)
- `-u, --backward-mu <float>,<float>`: Backward mutation rates (default: 1e-9,1e-9)
- `-v, --forward-mu <float>,<float>`: Forward mutation rates (default: 1e-9,1e-9)

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 4N+1 probabilities over the concatenated pre-adaptive and adaptive phase states. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-c, --integration-cutoff <float>`: Starting-copy integration cutoff (default:
  1e-10). When the starting state is not fixed with `-p`, the solver integrates
  over the number of copies a new mutation produces. That distribution is the
  zero-copy row of the transition matrix conditioned on at least one copy
  arising, and this cutoff truncates its tail: starting copy numbers whose
  probability falls below it are not integrated over. It has no effect when `-p`
  is given, or when the forward mutation rate is zero.
- `-p, --starting-copies <int>`: Initial allele count (default: automatic)

### Execution Parameters
- `--num-threads <int>`: Number of threads
- `--force`: Skip parameter validation
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q <file>`: Write combined transition matrix
- `--output-R <file>`: Write absorption matrix
- `--csv`: Output in CSV format
- `--json`: Output in JSON format

## Output Format

### Standard Output (CSV/Console)
```
Model,N,s1,s2,h1,h2,u1,u2,v1,v2,lambda,T_fix,rate
sweep,1000,0,-0.001,0.01,0.5,0.5,1e-9,1e-9,1e-9,1e-9,0.001,125000.5,8e-06
```

### JSON Output
```json
{
  "model": "sweep",
  "parameters": {
    "N": 1000,
    "phases": [
      {"s": -0.001, "h": 0.5, "u": 1e-9, "v": 1e-9},
      {"s": 0.01, "h": 0.5, "u": 1e-9, "v": 1e-9}
    ],
    "lambda": 0.001,
    "alpha": 1e-20
  },
  "results": {
    "T_fix": 125000.5,
    "substitution_rate": 8e-06
  },
  "execution_time": "3.45s"
}
```

## Usage Examples

### Basic sweep from neutral standing variation
```bash
wfes_sweep --fixation -N 1000 -s 0,0.01 -L 0.001
```

### Sweep from deleterious standing variation
```bash
wfes_sweep --fixation -N 5000 -s -0.001,0.01 -L 0.0001
```

### With mutation and dominance
```bash
wfes_sweep --fixation -N 1000 -s -0.002,0.02 -h 0.2,0.8 -u 1e-8,1e-8 -v 1e-7,1e-7 -L 0.001
```

## Technical Notes

1. **Standing Variation**: Models accumulation of variation before selection becomes positive
2. **Phase Duration**: Expected time in pre-adaptive phase is 1/λ generations
3. **No Extinction**: Pre-adaptive phase prevents allele loss (non-absorbing at 0)
4. **Transition Matching**: Allele frequencies are matched when transitioning between phases
5. **Computational Efficiency**: Only requires solving for fixation times, not full distribution

## Biological Interpretation

The two regimes represent a population that carries variation under one selective
regime and then experiences a change making that variation beneficial: a
previously neutral or deleterious allele becoming advantageous. This is the soft
sweep case, in which adaptation draws on variation already present rather than on
a new mutation.

The output separates the two contributions. T_reg1 is the expected wait under the
pre-adaptive regime, which equals 1/lambda; T_reg2 is the expected duration of the
sweep itself. They sum to the expected substitution time, so the split states how
much of the total is waiting and how much is the sweep.

