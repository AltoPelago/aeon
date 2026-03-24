export interface PRNG {
    next(): number;
    int(maxExclusive: number): number;
    bool(probability?: number): boolean;
}

export function createPrng(seed: number): PRNG {
    let state = (seed >>> 0) || 1;

    return {
        next(): number {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return (state >>> 0) / 0x100000000;
        },
        int(maxExclusive: number): number {
            if (maxExclusive <= 1) {
                return 0;
            }
            return Math.floor(this.next() * maxExclusive);
        },
        bool(probability = 0.5): boolean {
            return this.next() < probability;
        },
    };
}
