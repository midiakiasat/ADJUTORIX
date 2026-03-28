export function sum(values) {
if (!Array.isArray(values)) {
throw new TypeError("values must be an array");
}
return values.reduce((total, value) => total + value, 0);
}

export function average(values) {
if (values.length === 0) {
throw new Error("cannot average empty input");
}
return sum(values) / values.length;
}

if (process.argv[1] && process.argv[1].endsWith("/src/index.js")) {
const numbers = [2, 4, 6, 8];
const summary = {
count: numbers.length,
sum: sum(numbers),
average: average(numbers)
};
console.log(JSON.stringify(summary, null, 2));
}
