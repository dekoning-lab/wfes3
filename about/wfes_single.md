# WFES Single

## Description

WFES Single analyses one population whose parameters do not change over time,
and is the baseline the other programs extend. It solves the discrete
Wright-Fisher chain directly with sparse linear algebra, so absorption
probabilities, conditional and unconditional times and their variances, sojourn
times, equilibrium frequencies, allele age and establishment all come from the
same transition matrix. Each of the other programs relaxes one assumption made
here: `wfes_switching` and `wfes_sequential` let the parameters change over
time, the `time_dist` and `phase_type` programs return whole probability
distributions instead of their moments, and the WFAFS programs follow the
frequency spectrum through a demographic history.

Because the chain is solved exactly, none of the standard closed-form
assumptions is required: infinite sites, weak mutation, weak selection, and
small per-generation changes in allele frequency. Bidirectional recurrent
mutation is present throughout, and the extinction and fixation boundaries are
represented exactly, where diffusion treatments have to work around them. This
matters most where the classical results are least reliable: at
population-scaled mutation rates approaching 1, under strong or recessive
selection, and in small populations. Allele age is computed exactly for any
observed frequency, which is how the stochastic slowdown for weakly deleterious
rare alleles was identified (De Sanctis et al. 2017), and establishment is
treated as its own event, defined by the odds ratio between eventual fixation
and extinction, rather than as a synonym for fixation.

The one numerical approximation is the truncation of transition probabilities
below `--alpha`, which controls matrix sparsity.

## Mathematical Model

The Wright-Fisher model describes allele frequency dynamics in a finite population. Given i copies of an allele at time t, the probability of having j copies at time t+1 is:

$$P(i,j) = \binom{2N}{j} \psi(i)^j (1-\psi(i))^{2N-j}$$

Where ψ(i) is the binomial sampling probability incorporating selection and mutation:

$$\psi(i) = \frac{[(1+s)p^2 + (1+sh)pq](1-u) + [(1+sh)pq + q^2]v}{\bar{w}}$$

- p = i/(2N): frequency of focal allele
- q = 1-p: frequency of alternative allele  
- s: selection coefficient
- h: dominance coefficient
- u: backward mutation rate (A→a)
- v: forward mutation rate (a→A)
- w̄: mean population fitness

## Modes of Operation

### 1. Standard Wright-Fisher (--absorption)
Calculates statistics with both extinction (i=0) and fixation (i=2N) as absorbing states.

**Key equations:**
- Fundamental matrix: **N** = (I - Q)^(-1)
- Absorption probabilities: **B** = **N** × **R**
- Conditional times: T_abs(k) = Σ E(i,k)(j)

### 2. Substitution Model (--fixation)
Only fixation is absorbing; extinction is transient. Calculates substitution rates.

**Key equation:**
- Time between fixations: T_b.fix = Σ N(0,j)

### 3. Sojourn Times (--fundamental)
Sojourn times are defined per starting state: entry (i, j) of the fundamental
matrix N is the expected number of generations spent at count j before
absorption, having started at count i. There are therefore two outputs, and `-p`
says which one is wanted.

With `-p <count>`, one starting state is named, so one row of N is computed and
reported, together with its sum, the expected time to absorption from that
count. This is a single solve rather than the 2N-1 the whole matrix costs, and
`--output-N` writes that row.

Without `-p`, every starting state is wanted, so the whole matrix is computed and
`--output-N` writes all 2N-1 rows.

`--initial` is refused in this mode and `--integration-cutoff` does not apply:
both describe a distribution over starting states, and a sojourn time averaged
over the state it is conditioned on is not what this mode reports. `--output-V`
needs the whole matrix, so requesting it computes N in full even when `-p` names
a single row.

### 4. Establishment Properties (--establishment)
Calculates probabilities and times related to allele establishment thresholds.

### 5. Allele Age (--allele-age)
Computes exact moments of the allele age distribution, conditional on the
allele being observed at `x` copies today. The age distribution is
f(t) = [Q^t]_(p,x) / [(I-Q)^-1]_(p,x) over t = 0, 1, 2, ..., and its k-th raw
moment is [Li_(-k)(Q)]_(p,x) / [(I-Q)^-1]_(p,x), where Li is the matrix
polylogarithm (De Sanctis, Krukov & de Koning). By default the mean and
standard deviation are reported; `--num-moments k` (up to 10) reports the
first k raw moments, with skewness from k >= 3 and excess kurtosis from
k >= 4. Each additional moment costs one extra back-substitution against the
same factorization.

When the starting count is integrated over the mutation-injection
distribution, all reported quantities -- `E_T`, `Std_T`, and the raw moments --
describe the same mixture distribution: the age of an allele whose starting
count was drawn from the injection weights. (Before 2026-08, `Std_T` under
integration was the weighted average of per-start standard deviations, which
omits the between-start spread of the means; it is now the mixture's own
standard deviation, consistent with the raw moments.)

### 6. Equilibrium Distribution (--equilibrium)
Calculates stationary distribution when all states are transient.

**Key equation:**
- Equilibrium: π × P = π, where Σπ(i) = 1

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size (diploid individuals)

### Model Parameters  
- `-s, --selection <float>`: Selection coefficient (default: 0)
- `-h, --dominance <float>`: Dominance coefficient [0,1] (default: 0.5)
- `-u, --backward-mu <float>`: Backward mutation rate A→a (default: 1e-9)
- `-v, --forward-mu <float>`: Forward mutation rate a→A (default: 1e-9)

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 2N-1 probabilities over starting copy counts 1..2N-1. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-c, --integration-cutoff <float>`: Starting-copy integration cutoff (default:
  1e-10). When the starting state is not fixed with `-p`, the solver integrates
  over the number of copies a new mutation produces. That distribution is the
  zero-copy row of the transition matrix conditioned on at least one copy
  arising, and this cutoff truncates its tail: starting copy numbers whose
  probability falls below it are not integrated over. It has no effect when `-p`
  is given, or when the forward mutation rate is zero.
- `-p, --starting-copies <int>`: Starting allele count (optional)
- `-x, --observed-copies <int>`: Observed count for allele age (required for --allele-age)
- `--num-moments <int>`: Number of allele-age raw moments to report (1-10, default 2; --allele-age only)

### Execution Parameters
- `--num-threads <int>`: Number of threads (default: system max)
- `--force`: Skip parameter validation
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q <file>`: Write transition matrix Q
- `--output-R <file>`: Write absorption matrix R  
- `--output-N <file>`: Write fundamental matrix N
- `--output-V <file>`: Write variance matrix V
- `--output-E <file>`: Write equilibrium distribution
- `--csv`: Output in CSV format
- `--json`: Output in JSON format

## Output Format

### Standard Output (CSV/Console)
```
Model,Mode,N,s,h,u,v,a,P_ext,P_fix,T_ext,T_fix
absorption,absorption,1000,0.01,0.5,1e-9,1e-9,1e-20,0.9801,0.0199,3960.2,5020.1
```

### JSON Output
```json
{
  "model": "absorption",
  "parameters": {
    "N": 1000,
    "s": 0.01,
    "h": 0.5,
    "u": 1e-9,
    "v": 1e-9,
    "alpha": 1e-20
  },
  "results": {
    "P_ext": 0.9801,
    "P_fix": 0.0199,
    "T_ext": 3960.2,
    "T_fix": 5020.1
  },
  "execution_time": "2.34s"
}
```

## Usage Examples

### Basic absorption calculation
```bash
wfes_single --absorption -N 1000 -s 0.01
```

### Substitution rate with mutation
```bash
wfes_single --fixation -N 5000 -s 0.001 -u 1e-8 -v 1e-8
```

### Allele age calculation
```bash
wfes_single --allele-age -N 1000 -x 100 -s 0.01
```

### Full fundamental matrix (small N only)
```bash
wfes_single --fundamental -N 100 --output-N matrix.csv
```

## Technical Notes

1. **Sparse Matrix Solver**: Uses sparse linear algebra (SuiteSparse/UMFPACK, ParU, or Pardiso where MKL is available)
2. **Numerical Precision**: Double precision throughout; configurable tail truncation
3. **Memory Requirements**: O(N²) for full matrix modes; O(N) for row-wise calculations
4. **Integration**: Automatically integrates over starting frequencies when u > 0
5. **Thread Safety**: Fully thread-safe for parallel execution