export {};
// export class CacheDuration
// {
//     private constructor() { }
//     // this is deliberately private because the lowest common denominator for caching is always seconds
//     private static fromSeconds(seconds: number): number
//     {
//         given(seconds, "seconds").ensureHasValue().ensureIsNumber();
//         return seconds;
//     }
//     public static fromMinutes(minutes: number): number
//     {
//         given(minutes, "minutes").ensureHasValue().ensureIsNumber();
//         return this.fromSeconds(minutes * 60);
//     }
//     public static fromHours(hours: number): number
//     {
//         given(hours, "hours").ensureHasValue().ensureIsNumber();
//         return this.fromMinutes(hours * 60);
//     }
//     public static fromDays(days: number): number
//     {
//         given(days, "days").ensureHasValue().ensureIsNumber();
//         return this.fromHours(days * 24);
//     }
// }
//# sourceMappingURL=cache-service.js.map