# WFES Sequential

## Description

WFES Sequential computes the same quantities as `wfes_switching` for a strictly
ordered demographic history. The population passes through a list of epochs in
order, each with its own size, selection, dominance and mutation rates. Epoch
durations are geometrically distributed with the mean the user gives
(`--exp-time`): each generation the process leaves epoch i for epoch i+1 with
probability 1/t_i, and after the final epoch it exits to a timeout state. What
distinguishes this program from `wfes_switching` is the switching structure, a
forward chain with no returns, not the dwell-time law; for exact epoch lengths
applied deterministically, see `wfafs_deterministic`, which computes frequency
spectra rather than absorption quantities.

The calculation is exact for the whole history rather than for each epoch
separately, so an allele's fate depends on where in the history it arose. The
per-epoch decomposition reports where absorption occurred and how many
generations preceded it in each epoch, which is the information lost when a
piecewise history is summarised by a single effective population size, the usual
way such histories enter closed-form theory.

## Mathematical Model

The model progresses through k sequential epochs, each with:
- Population size Nᵢ
- Duration Gᵢ generations
- Selection, dominance, and mutation parameters

### Sequential Progression

For each epoch i:
1. Apply Wright-Fisher dynamics with parameters θᵢ for Gᵢ generations
2. Transition to epoch i+1 with frequency-matching transformation
3. Continue until reaching absorbing state or timeout

### Transition Between Epochs

When transitioning from epoch i to i+1:
$$P(j \mid k) = \binom{2N_{i+1}}{j} \left(\frac{k}{2N_i}\right)^j \left(1-\frac{k}{2N_i}\right)^{2N_{i+1}-j}$$

This preserves allele frequency while adjusting for population size changes.

### Absorption Probabilities

The model tracks three outcomes:
- P_ext: Probability of extinction (reaching 0 copies)
- P_fix: Probability of fixation (reaching 2N copies)
- P_tmo: Probability of timeout (no absorption within time limit)

## Input Parameters

### Required Parameters (comma-separated lists)
- `-N, --pop-sizes <int,...>`: Population sizes for each epoch
- `-t, --exp-time <float,...>`: Expected duration in generations for each epoch

### Optional Parameters (comma-separated)
- `-s, --selection <float,...>`: Selection coefficients (default: all 0)
- `-h, --dominance <float,...>`: Dominance coefficients (default: all 0.5)
- `-u, --backward-mu <float,...>`: Backward mutation rates (default: all 1e-9)
- `-v, --forward-mu <float,...>`: Forward mutation rates (default: all 1e-9)
- `-p, --starting-prob <float,...>`: Probability of starting in each epoch (one value per epoch, summing to 1; default `1,0,...` — start in Epoch 1). This is a distribution over *epochs*, not allele frequencies.
- `--starting-copies <int>`: Fixed starting allele count in the first epoch (1 to 2N_1-1). Replaces the integration over the copy numbers a new mutation produces; without it (and without `--initial`) that integration is the default.

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of sum over epochs of (2N_i - 1) probabilities over the concatenated transient states of all epochs. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-c, --integration-cutoff <float>`: Starting-copy integration cutoff (default:
  1e-10). When the starting state is not fixed with `--starting-copies` and no
  `--initial` file is given, the solver integrates over the number of copies a
  new mutation produces. That distribution is the
  zero-copy row of the transition matrix conditioned on at least one copy
  arising, and this cutoff truncates its tail: starting copy numbers whose
  probability falls below it are not integrated over. It has no effect when
  `--starting-copies` or `--initial` is given, or when the forward mutation
  rate is zero. (`-p, --starting-prob` sets the distribution over which
  *epoch* the population starts in — a different thing from the starting
  copy number.)

### Execution Parameters
- `--num-threads <int>`: Number of threads
- `--force`: Skip parameter validation
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q <file>`: Write transition matrices
- `--output-R <file>`: Write absorption matrices
- `--output-N <file>`: Write fundamental matrix
- `--output-B <file>`: Write absorption probability matrix
- `--output-N-ext <file>`: Write expected times to extinction
- `--output-N-fix <file>`: Write expected times to fixation
- `--output-N-tmo <file>`: Write expected times to timeout
- `--csv`: Output in CSV format
- `--json`: Output in JSON format

## Output Format

### Standard Output
```
P_ext = 0.95
P_fix = 0.04
P_tmo = 0.01
T_ext = 3500 +/- 1200
T_fix = 8500 +/- 2100
T_tmo = 10000 +/- 0
```

### CSV Output
```
N1,N2,N3,G1,G2,G3,s1,s2,s3,h1,h2,h3,u1,u2,u3,v1,v2,v3,p1,p2,p3,a,P_ext,P_fix,P_tmo,T_ext,T_fix,T_tmo
1000,100,5000,100,50,200,0,0,0.01,0.5,0.5,0.5,1e-9,1e-9,1e-9,1e-9,1e-9,1e-9,1,0,0,1e-20,0.95,0.04,0.01,3500,8500,10000
```

## Usage Examples

### Simple bottleneck
```bash
wfes_sequential -N 1000,50,1000 --exp-time 100,20,100
```

### Selection during expansion
```bash
wfes_sequential -N 100,1000,10000 --exp-time 50,100,200 -s 0,0.001,0.01
```

### Complex demographic with mutation
```bash
wfes_sequential -N 5000,500,50,500,5000 --exp-time 100,50,10,50,100 -s 0,0,-0.1,0,0.01 -u 1e-8,1e-8,0,1e-8,1e-8
```

### Starting epoch drawn from a distribution
```bash
wfes_sequential -N 1000,5000 --exp-time 100,200 -p "0.9,0.1"
```

## Technical Notes

1. **Geometric Timing**: Each epoch's duration is geometrically distributed with mean `--exp-time`; the process leaves epoch i with probability 1/t_i per generation
2. **No Back-Migration**: Sequential progression only (no returning to previous states)
3. **Frequency Preservation**: Allele frequencies are maintained during size changes
4. **Timeout Handling**: There is no generation cap flag; after the final epoch, the process exits to the timeout state (`P_tmo`) at rate 1/`--exp-time` for that epoch, the same geometric mechanism that carries it between earlier epochs
5. **Memory Efficiency**: Only stores current state, not full trajectory

## Biological Applications

Sequential switching suits a demographic history whose order is known: a
founder event followed by growth, a bottleneck, an expansion. The epochs occur
strictly in sequence, each lasting a geometrically distributed time with the
mean given by --exp-time, so the history's shape and expected timing are inputs
to the calculation even though individual durations vary.

The per-epoch decomposition reports where absorption occurred and where the time
was spent before it, which is what this provides over running the same parameters
as a single averaged model.

