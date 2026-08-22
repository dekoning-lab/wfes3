# WFAFS Deterministic

## Description

WFAFS Deterministic propagates a probability distribution over allele counts
through a stated sequence of demographic epochs, each applied for exactly the
number of generations given. The result is the expected allele frequency
spectrum at the end of that history. Where `wfes_sequential` reports absorption
probabilities and times for the same kind of history, this program reports the
frequency distribution itself.

Both WFAFS programs propagate a full distribution under the Wright-Fisher
transition matrix, so genetic drift is part of the model in both. They differ in
how epoch durations are treated: exactly as specified here, geometrically
distributed in `wfafs_stochastic`. Because the spectrum is computed rather than
sampled, statistics of it (heterozygosity, the proportion still segregating, the
mass at either boundary) follow without simulation error, and no assumption of
equilibrium is required at any point in the history.

## Mathematical Model

The model propagates an initial frequency distribution through a series of demographic epochs using Wright-Fisher transition matrices.

### Transition Matrices

For each epoch i with parameters (Nᵢ, sᵢ, hᵢ, uᵢ, vᵢ):
$$P_{ij} = \binom{2N_i}{j} \psi_i(k)^j (1-\psi_i(k))^{2N_i-j}$$

### Demographic Transitions

When population size changes from Nᵢ to Nᵢ₊₁:
$$\Gamma(k,j) = \binom{2N_{i+1}}{j} \left(\frac{k}{2N_i}\right)^j \left(1-\frac{k}{2N_i}\right)^{2N_{i+1}-j}$$

### Evolution Algorithm

1. Start with initial distribution π₀ (a fixed count, an integration over the
   mutation-injection distribution, or a supplied file -- one is required)
2. For each epoch i lasting Gᵢ generations:
   - Apply P^(Gᵢ) via repeated sparse matrix-vector multiplication
   - Apply transition matrix Γ if population size changes
3. Output final frequency distribution

### Expected Heterozygosity

$$H_{exp} = 2 \sum_i \pi_i \, \frac{i}{2N} \left(1 - \frac{i}{2N}\right)$$

## Input Parameters

### Initial Frequency
One of these three is required; there is no implicit default starting state,
and omitting all three is refused ("no starting state given").
- `-p, --starting-copies <int>`: Starting copy number, a fixed count
- `-c, --integration-cutoff <float>`: Integrate over the starting-copy
  distribution a new mutation produces (row 0 of the first epoch's matrix,
  conditioned on at least one copy), truncated at this probability
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 2N+1 probabilities over allele counts 0..2N in the first epoch. It replaces the point mass at `-p`, and is renormalised if it does not sum to 1. A point mass reproduces the corresponding `-p` run exactly.

### Demographic Vectors (comma-separated)
- `-N, --pop-size <int,...>`: Population sizes for each epoch (required)
- `-G, --generations <int,...>`: Duration in generations for each epoch (required)
- `-s, --selection <float,...>`: Selection coefficients (required -- unlike
  the other WFES/WFAFS tools, this one has no default and must be given
  explicitly, even as a vector of 0s)
- `-h, --dominance <float,...>`: Dominance coefficients (`--help` shows this menu; `-h` is dominance, as in every WFES tool)
- `-u, --backward-mu <float,...>`: Backward mutation rates
- `-v, --forward-mu <float,...>`: Forward mutation rates (`--verbose` is long-only)

This model is non-absorbing and keeps the two boundary rows -- 0 copies and 2N
copies -- that absorbing models drop, and each needs a binomial success
probability strictly inside (0, 1): row 0 is exactly the forward mutation rate
`v` for that epoch, and row 2N is exactly `1 - u`, which rounds to 1.0 for any
`u` below about 1.1e-16. An epoch whose rates put either boundary at 0 or 1 --
`v` = 0, `u` = 0, or a `u`/`v` small enough to underflow -- is refused with a
diagnostic naming the offending rate and epoch, rather than silently
propagating a `nan` through the rest of the history. A non-finite `-s` or `-h`
is refused for a related reason: left unchecked it would be clamped into a
lethal-homozygote model and reported as though it were the model asked for.

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused outright, with no override flag to bypass that check. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `--num-threads <int>`: Number of threads
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `-o, --output-file <file>`: Write output to this file (omit to print to stdout, as shown below)
- `--csv`: Output in CSV format
- `--verbose`: Detailed progress output

## Output Format

### Standard Output
```
0	0.308533
1	0.00565134
2	0.0060866
3	0.00620928
...
2N	0.00843691
```

Where:
- Frequency: Number of copies (0 to 2N)
- Count: Observed count (if provided)
- Expected: Expected count from model

### Summary Statistics
```
Expected heterozygosity: 0.0234
Total segregating sites: 1489
Mean allele frequency: 0.0156
Execution time: 2.1s
```

## Usage Examples

### Simple bottleneck
```bash
wfafs_deterministic --pop-size 10000,100,10000 --generations 1000,50,1000 \
                   --selection 0,0,0 -p 5000
```

### Selection during expansion
```bash
wfafs_deterministic --pop-size 1000,5000,20000 --generations 200,500,1000 \
                   --selection 0,0.001,0.01 -c 1e-10
```

### Complex demographic history
```bash
wfafs_deterministic --pop-size 5000,500,50,500,5000 --generations 100,50,10,50,100 \
                   --selection 0,0,-0.1,0,0.01 --dominance 0.5,0.5,0.2,0.5,0.8 \
                   -c 1e-10
```

### Starting from specific frequency
```bash
wfafs_deterministic -p 10 --pop-size 1000,5000 --generations 500,1000 --selection 0,0
```

### With varying mutation rates
```bash
wfafs_deterministic --pop-size 1000,10000 --generations 1000,2000 --selection 0,0 \
                   --backward-mu 1e-8,1e-7 --forward-mu 1e-8,1e-6 -c 1e-10
```

`-s` (selection) and a starting state (`-p`, `-c`, or `-i`) are both required
by this tool -- there is no default for either, unlike its sibling programs.

## Technical Notes

1. **Deterministic Timing**: Each epoch lasts exactly the specified generations
2. **Frequency Matching**: Preserves expected frequencies during size changes
3. **Required Starting State**: No default; give a fixed count (`-p`), an
   integration cutoff (`-c`), or a distribution file (`-i`)
4. **Sparse Computation**: Efficient matrix-vector operations
5. **No Genetic Drift**: Tracks expected values, not stochastic realizations

## Applications

The output is the allele frequency distribution after a stated sequence of
population sizes and selection regimes, which supports comparing an observed
frequency spectrum against the expectation under that history: diversity lost
through a bottleneck, the effect of a founder event, or departure from a neutral
expectation.

The output is the whole distribution, so heterozygosity, the proportion still
segregating, and the mass at either boundary can all be computed from it.

## Comparison with Related Programs

Both WFAFS programs propagate a probability distribution over allele counts under
the same Wright-Fisher transition matrix, so both include drift. They differ in how
epoch durations enter the model. This program applies each epoch's matrix for
exactly the number of generations given by --generations. wfafs_stochastic treats the
epoch sequence as a switching process with geometric dwell times of mean
--generations, and obtains the result from a single linear solve rather than by
iterating.

wfes_single --equilibrium gives the stationary distribution of one
constant-parameter model. phase_type_dist gives a distribution over times rather
than over allele frequencies.

## Limitations

1. **Deterministic epoch durations**: each epoch lasts exactly the specified number
   of generations; wfafs_stochastic provides geometrically distributed durations
2. **Single population**: no spatial structure, migration or population splits
3. **Discrete generations**: the Wright-Fisher assumption of non-overlapping generations
4. **Biallelic**: one locus, two alleles

