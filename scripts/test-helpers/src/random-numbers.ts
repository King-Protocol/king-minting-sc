function randomFloat(min: number, max: number) {
    return Math.random() * (max - min) + min;
}
function randomInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export { randomInt, randomFloat };
