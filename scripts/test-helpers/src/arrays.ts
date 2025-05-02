function shuffleArray<T>(arr: T[]): T[] {
    let j: number;
    for (let i = arr.length - 1; i > 0; --i) {
        j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function getArrayWithout<T>(array: T[], index: number): T[] {
    return array.filter((_, i) => i !== index);
}

export { shuffleArray, getArrayWithout };
