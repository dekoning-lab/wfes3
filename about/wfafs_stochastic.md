# WFAFS Stochastic

## Description

WFAFS Stochastic computes the expected allele frequency spectrum for a
demographic history whose epoch durations are geometrically distributed, by
solving the whole history as a single linear system. `wfafs_deterministic`
applies each epoch's matrix for exactly the number of generations specified,
iterating; this program solves once, which is faster when the history is long.

The spectrum is the quantity demographic inference compares against an observed
site frequency spectrum, and because each evaluation is one solve it is
practical inside a likelihood or ABC loop where the spectrum must be recomputed
for many parameter combinations. The model is one locus in one population:
population splits, migration and admixture are outside it.

## Mathematical Model

The model uses a time-heterogeneous Wright-Fisher switching model to compute allele frequency distributions efficiently.

### Switching Model Framework

For each demographic epoch i:
- Population size: Nᵢ
- Expected duration: Gᵢ generations
- Scaling factor: fᵢ (for computational efficiency)
- Selection and mutation parameters: sᵢ, hᵢ, uᵢ, vᵢ

### Switching Matrix Construction

The switching matrix S captures transitions between epochs:
$$S(i,i) = 1 - \frac{1}{G_i} \quad \text{(stay in epoch } i\text{)}$$

$$S(i,i+1) = \frac{1}{G_i} \quad \text{(move to epoch } i+1\text{)}$$

### Linear System Solution

Instead of iterative computation, the model solves:
$$(I - Q)X = B$$

Where:
- Q is the compound Wright-Fisher switching matrix
- I is the identity matrix
- B encodes the initial conditions
- X contains the allele frequency distribution at all time points

### Computational Scaling

The scaling factors fᵢ allow efficient computation:
- Scaled population: N'ᵢ = Nᵢ / fᵢ
- Scaled generations: G'ᵢ = Gᵢ / fᵢ
- Scaled selection: s'ᵢ = sᵢ × fᵢ
- Scaled mutation: u'ᵢ = uᵢ × fᵢ, v'ᵢ = vᵢ × fᵢ

### Final Distribution

The allele frequency distribution at the final time point is extracted from the
solution vector and projected up to the real population's 2N+1 states; unless
`--no-project` is given, it is then binned back down onto this model's own
scaled 2(N/f)+1 states for output. The down-projection is mass-conserving: each
output bin is the SUM of the states that map into it, so the binned spectrum
carries the same total and the same segregating probability as the
up-projected one.

## Input Parameters

### Initial Configuration
- `-p, --starting-copies <int>`: Starting copy number
- `-i, --initial <path>`: Initial state distribution, as a CSV column of probabilities over this model's states. It replaces the point mass at `-p`.
- `--no-project`: Report the up-projected distribution over the real population's
  2N+1 states instead of binning it back down onto this model's own scaled
  2(N/f)+1 states (the default).

### Population Parameters (comma-separated)
- `-N, --pop-size <int,...>`: Population sizes for each epoch
- `-G, --generations <float,...>`: Expected generations in each epoch
- `-f, --factor <float,...>`: Matrix approximation factors for computational efficiency
- `-s, --selection <float,...>`: Selection coefficients
- `-h, --dominance <float,...>`: Dominance coefficients
- `-u, --backward-mu <float,...>`: Backward mutation rates
- `-v, --forward-mu <float,...>`: Forward mutation rates

Each of `-G`, `-f`, `-s`, `-h`, `-u` and `-v` must give exactly one value per
model named by `-N` -- a short or long vector is refused by name (for example
"Backward mutation rates (-u) has 1 value(s) but there are 2 models"), never
padded or silently truncated. Every `-f` value must also be a finite positive
number.

Because this model is non-absorbing, it keeps the two boundary rows (0 copies
and 2N copies) that absorbing models drop, and each needs a binomial success
probability strictly inside (0, 1): row 0 is exactly the forward mutation rate
`v`, and row 2N is exactly `1 - u`, which rounds to 1.0 for any `u` below about
1.1e-16. A model that puts either boundary at 0 or 1 -- `v` = 0, `u` = 0, or a
`u`/`v` small enough to underflow -- is refused with a diagnostic naming the
offending rate and model, rather than silently writing a spectrum full of
`nan`. The check runs on the rates each matrix is actually built from: the
`-f`-rescaled rates for the switching solve, and the unscaled rates for the
final up-projection.

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `--num-threads <int>`: Number of threads
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q`: Write transition matrices
- `--output-R`, `--output-N-ext`, `--output-N-fix`, `--output-N-tmo`: NOT
  AVAILABLE for this tool. wfafs_stochastic builds a non-absorbing switching
  chain with no extinction or fixation boundary, so it has no
  transient-to-absorbing matrix and no extinction-, fixation- or
  timeout-conditional sojourn time to write; requesting any of the four
  refuses at startup and leaves no file behind.
- `--verbose`: Detailed progress output

## Output Format

### Standard Output
```
Copy_Number    Probability
0              0.0234
1              0.1523
2              0.0834
3              0.0445
4              0.0298
...
2N             0.0001
```

### Summary Statistics
```
Total segregating sites: 1489
Singletons: 523
Mean frequency: 0.0234
Private alleles (Pop1): 234
Private alleles (Pop2): 189
Execution time: 5.3s
```

## Usage Examples

### Simple bottleneck with recovery
```bash
wfafs_stochastic -N 10000,100,5000 -G 1000,50,500 -f 1,1,1
```

### Using scaling factors for efficiency
```bash
wfafs_stochastic -N 10000,1000,5000 -G 1000,500,1000 -f 10,1,5
```

### Selection during population changes
```bash
wfafs_stochastic -N 1000,5000 -G 500,1000 -f 1,1 -s 0,0.01
```

### Complex demographic history
```bash
wfafs_stochastic -N 5000,500,50,1000,10000 -G 200,100,20,200,500 \
                -f 1,1,1,1,1 -s 0,0,-0.1,0,0.01 \
                -u 1e-8,1e-8,1e-9,1e-8,1e-7
```
(This is a non-absorbing model, so every `-u`/`-v` must stay strictly above
0 -- see the boundary-refusal note above; `-u ...,0,...` for the bottleneck
epoch would be refused rather than silently treated as "no recurrent
mutation".)

### Starting from specific allele count
```bash
wfafs_stochastic -N 1000,5000,10000 -G 100,500,1000 -f 1,1,1 -p 10
```

## Technical Notes

1. **Linear System Approach**: Solves (I-Q)X = B instead of iterating
2. **Switching Model**: Time-heterogeneous Wright-Fisher process
3. **Scaling Factors**: Allow efficient computation with large populations
4. **Single Solve**: Entire demographic history computed in one operation
5. **Memory Scaling**: O(Σ Nᵢ²) for all epochs combined

## Applications

The output is an expected allele frequency spectrum for a specified demographic
history, which is the quantity demographic inference compares against an observed
SFS. Each evaluation is a single linear solve, so the program is practical inside a
likelihood or ABC loop where the spectrum has to be recomputed across many
parameter combinations.

The model is one locus in one population. Population splits, migration and
admixture are outside it, and comparisons across sampled populations need a model
that represents them.

## Comparison with Related Programs

wfafs_deterministic propagates the same distribution under the same transition
matrix, applying each epoch's matrix for exactly the number of generations given by
--generations. This program instead treats the epoch sequence as a switching process with
geometric dwell times of mean --generations, and solves the whole history as one
linear system, which is faster when the history is long.

wfes_switching applies the same switching framework to absorption probabilities and
times rather than to the frequency spectrum.

## Advanced Features

### Scaling Factors
- Reduce matrix dimensions while preserving dynamics
- Essential for large population sizes
- Automatic rescaling of parameters

### Projection Options
- The final epoch's distribution is always projected up to the real
  population's 2N+1 states first
- By default it is then binned back down onto this model's own scaled
  2(N/f)+1 states; `--no-project` reports the up-projected, real-size result
  instead
- Skipped entirely when the last model's `-f` is 1, where scaled and real size
  already coincide

### Initial Conditions
- Start from specific allele count
- Load initial distribution from file
- Default to equilibrium distribution

## Limitations

1. **Sequential Epochs**: Models must proceed sequentially
2. **Single Locus**: No linkage or recombination
3. **Memory Requirements**: Large linear system for complex histories
4. **No Population Splits**: Current implementation handles single lineage