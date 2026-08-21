# Time Distribution

## Description

Time Distribution computes the full probability density and cumulative
distribution of the time to extinction and to fixation, where `wfes_single`
computes their means and variances. The two absorbing outcomes are reported
separately, each with its own distribution, because a population reaching
fixation and one reaching extinction take amounts of time that can differ by
orders of magnitude.

Distributions are needed wherever the question concerns the spread of outcomes
or the probability of one of them. Fixation times are strongly right-skewed, so
the duration an experiment must run to observe fixation with a stated
probability depends on the upper tail rather than on the expectation. The
calculation is exact for the discrete chain at every point of the distribution,
including the tails, where diffusion approximations are least accurate and where
simulation needs the most replicates.

## Mathematical Model

The time to absorption follows a phase-type distribution. For a Wright-Fisher process starting with i copies:

### Probability Density Function

The PDF for absorption at time t in state k is:
$$f_k(t) = \alpha \, e^{Qt} (-Q) \, e_k$$

Where:
- α: Initial distribution vector
- Q: Transient transition rate matrix  
- e_k: Unit vector for absorbing state k

### Cumulative Distribution Function

$$F_k(t) = 1 - \alpha \, e^{Qt} \mathbf{1}$$

### Conditional Distributions

For extinction (k=0) and fixation (k=2N):
$$f_{ext}(t \mid \text{extinction}) = \frac{f_0(t)}{P_{ext}}$$

$$f_{fix}(t \mid \text{fixation}) = \frac{f_{2N}(t)}{P_{fix}}$$

### Matrix Exponential Computation

The matrix exponential e^(Qt) is computed using:
- Uniformization for small t
- Scaling and squaring for large t
- Padé approximation as needed

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size

### Model Parameters
- `-s, --selection <float>`: Selection coefficient (default: 0)
- `-h, --dominance <float>`: Dominance coefficient (default: 0.5)
- `-u, --backward-mu <float>`: Backward mutation rate (default: 1e-9)
- `-v, --forward-mu <float>`: Forward mutation rate (default: 1e-9)

### Distribution Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused outright, with no override flag to bypass that check. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 2N-1 probabilities over the transient states, allele counts 1..2N-1. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-b, --block-size <int>`: Block size for computation (default: 100)
- `-d, --distribution-cutoff <float>`: Stop when CDF reaches this value (default: 0.99999)
- `-m, --max-t <int>`: Maximum time to compute (default: 1000000)

### Computational Parameters
- `--no-recurrent-mu`: Disable recurrent mutation
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
Time    P_ext    P_fix    P_total    CDF_ext    CDF_fix    CDF_total
0       0        0        0          0          0          0
1       1.2e-4   8.1e-6   1.28e-4    1.2e-4     8.1e-6     1.28e-4
2       2.4e-4   1.6e-5   2.56e-4    3.6e-4     2.41e-5    3.84e-4
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
    "alpha": 1e-20,
    "distribution_cutoff": 0.99999
  },
  "statistics": {
    "E_ext": 3960.2,
    "E_fix": 5020.1,
    "Var_ext": 1.56e7,
    "Var_fix": 2.52e7,
    "P_ext": 0.9801,
    "P_fix": 0.0199
  },
  "distribution": [
    {"time": 0, "P_ext": 0, "P_fix": 0, "CDF_ext": 0, "CDF_fix": 0},
    {"time": 1, "P_ext": 1.2e-4, "P_fix": 8.1e-6, "CDF_ext": 1.2e-4, "CDF_fix": 8.1e-6},
    ...
  ],
  "execution_time": "12.5s"
}
```

## Usage Examples

### Basic time distribution
```bash
time_dist -N 1000 -s 0.01
```

### With mutation and extended time range
```bash
time_dist -N 5000 -s 0.001 -u 1e-8 -v 1e-8 -m 10000000 -d 0.999999
```

### High-resolution early times
```bash
time_dist -N 100 -s 0.1 -b 10 -m 10000
```

### Output to file with matrices
```bash
time_dist -N 500 --output-P dist.txt --output-Q trans.csv --output-R abs.csv
```

## Technical Notes

1. **Adaptive Time Steps**: Block size determines time resolution
2. **Numerical Stability**: Uses stable matrix exponential algorithms
3. **Conditional Distributions**: Automatically normalizes by total probability
4. **Memory Usage**: O(N²) for matrix storage, O(T×N) for distribution
5. **Precision Control**: Distribution cutoff ensures numerical accuracy

## Visualization Support

Output is designed for easy plotting:
- Column format compatible with gnuplot, R, Python
- CDF columns for distribution analysis
- Log-scale compatible for rare events

## Applications

Fixation times are strongly right-skewed, so a mean understates how long an
experiment must run to observe fixation with a given probability; that duration
depends on the upper tail. The extinction-time distribution answers the
corresponding question for loss, giving the probability that a segregating allele
is gone within a stated number of generations.

The calculation is exact for the discrete Wright-Fisher chain, so it can also be
used to check where diffusion approximations depart from the discrete model.

