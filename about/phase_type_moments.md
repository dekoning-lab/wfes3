# Phase Type Moments

## Description

Phase Type Moments computes moments of the substitution-time distribution
directly, by solving one sparse linear system per moment, without computing the
distribution itself. `phase_type_dist` returns the whole distribution over a
finite time horizon; this program returns exact moments with no horizon and no
truncation, and arbitrarily high orders are available at the cost of one solve
each.

The first two moments give the expected time to substitution and its variance,
and hence the substitution rate in Kimura's sense of one over the time between
fixations. Higher moments describe the shape, its skewness and tail weight,
which is where the distribution departs from the geometric form that Markovian
sequence-evolution models assume. Because the cost is one solve per moment
rather than one matrix-vector product per generation, moments remain feasible
for parameter combinations whose substitution times are far too long to compute
a distribution over.

## Mathematical Model

For a phase-type distribution PH(α, Q) representing substitution times:

### Moment Calculation

The k-th moment is computed directly:
$$E[T^k] = k! \, \alpha \, (-Q)^{-k} \mathbf{1}$$

This avoids matrix exponentials, using only sparse matrix inversions.

### Central Moments

From raw moments, central moments are derived:
- Mean: μ = E[T]
- Variance: σ² = E[T²] - μ²
- Skewness: γ₁ = (E[T³] - 3μE[T²] + 2μ³) / σ³
- Kurtosis: γ₂ = (E[T⁴] - 4μE[T³] + 6μ²E[T²] - 3μ⁴) / σ⁴

### Coefficient of Variation

$$CV = \frac{\sigma}{\mu}$$

### Moment Generating Function

At point s:
$$M(s) = \alpha \, (sI - Q)^{-1} (-Q) \, \mathbf{1}$$

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size
- `-k, --n-moments <int>`: Number of moments to compute

### Model Parameters
- `-s, --selection <float>`: Selection coefficient (default: 0)
- `-h, --dominance <float>`: Dominance coefficient (default: 0.5)
- `-u, --backward-mu <float>`: Backward mutation rate (default: 1e-9)
- `-v, --forward-mu <float>`: Forward mutation rate (default: 1e-9)

### Computational Parameters
- `-a, --alpha <float>`: Tail truncation weight for the transition matrix — the
  same mechanism described under `-a, --alpha` in `phase_type_dist` and
  `wfes_single`. There is no starting-frequency control for this tool; the
  only way to set a non-default starting state is `-i, --initial` (below).
- `--num-threads <int>`: Number of threads
- `--force`: Skip parameter validation
- `-r, --no-recurrent-mu`: Exclude recurrent mutation (included by default)
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-N <file>`: Write moments to file
- `--json`: Output in JSON format
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 2N probabilities over the transient states of the fixation-only model. It replaces however the starting state would otherwise be set, and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.

## Output Format

### Standard Output
```
Mean: 125000
Std Dev: 35000
Moments:
1: 1.25e+05
2: 1.785e+10
3: 2.89e+15
4: 5.21e+20
...
```

### JSON Output
```json
{
  "parameters": {
    "N": 1000,
    "s": 0.01,
    "h": 0.5,
    "u": 1e-9,
    "v": 1e-9,
    "n_moments": 20,
    "recurrent_mutation": true
  },
  "results": {
    "mean": 125000,
    "std_dev": 35000,
    "coefficient_of_variation": 0.28,
    "skewness": 1.2,
    "kurtosis": 4.5,
    "raw_moments": [
      125000,
      1.785e10,
      2.89e15,
      5.21e20,
      ...
    ]
  },
  "execution_time": "0.45s"
}
```

## Usage Examples

### Basic moment calculation
```bash
phase_type_moments -N 1000 -s 0.01 -k 10
```

### High-order moments for distribution fitting
```bash
phase_type_moments -N 5000 -s 0.001 -k 50
```

### Neutral moments with mutation
```bash
phase_type_moments -N 10000 -u 1e-8 -v 1e-8 -k 20
```

### Coarser truncation for a faster, less precise solve
```bash
phase_type_moments -N 1000 -s 0.01 -a 1e-6 -k 30
```

### Output to file with JSON
```bash
phase_type_moments -N 1000 -s 0.01 -k 100 --json --output-N moments.json
```

## Technical Notes

1. **Computational Efficiency**: O(k) sparse solves vs O(T) for full distribution
2. **Numerical Stability**: Stable for moments up to ~100 depending on parameters
3. **Recurrent Mutation**: Included by default; disable with `-r, --no-recurrent-mu`
4. **Starting State**: Default is 0 copies with mutation; a non-default starting state requires `-i, --initial`
5. **Sparse Methods**: Exploits sparsity for large N

## Applications

Moments are what method-of-moments estimation needs: matching an observed mean and
variance of substitution time against the model yields parameter estimates without
computing the distribution at all. They are also cheap enough to evaluate across a
parameter grid, which makes them practical for asking how substitution time scales
with N, s, or the mutation rates.

The third and fourth moments give the skewness and tail weight of the
distribution, which is the information a mean and variance alone omit.

## Moment Interpretation

1. **First Moment (Mean)**: Average substitution time
2. **Second Moment**: Relates to variance and spread
3. **Third Moment**: Asymmetry of distribution (skewness)
4. **Fourth Moment**: Tail behavior (kurtosis)
5. **Higher Moments**: Increasingly sensitive to distribution tails

## Comparison with phase_type_dist

The moments come from k sparse solves, where k is the number of moments requested.
The full distribution instead requires one matrix-vector product per generation, so
its cost grows with the time horizon rather than with the number of moments:
at N=100, s=0, this program returns the first two moments in 0.04 s, against 19.9 s
for phase_type_dist at --max-t 200000 and roughly 107 s at 1000000.

The horizon also bounds accuracy. phase_type_dist reports moments of the
distribution it managed to compute, so a run that reaches --max-t before the
cutoff underestimates them; the moments here carry no such truncation. Both
programs use the same transition matrix, so the difference is in what is computed
from it, not in the model.

