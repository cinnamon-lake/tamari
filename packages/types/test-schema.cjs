"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
function makeUpdateSchema(shape) {
    const newShape = {};
    for (const [key, schema] of Object.entries(shape)) {
        let s = schema;
        if (s.def?.type === 'default') {
            s = s.removeDefault();
        }
        newShape[key] = s.optional();
    }
    return zod_1.z.object(newShape);
}
const TestSchema = zod_1.z.object({
    name: zod_1.z.string().default('hello'),
    age: zod_1.z.number(),
});
const UpdateSchema = makeUpdateSchema(TestSchema.shape);
const result = { age: 5 };
console.log(UpdateSchema.parse({ age: 5 }));
