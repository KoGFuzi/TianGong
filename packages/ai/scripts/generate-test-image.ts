#!/usr/bin/env bun

import { createCanvas } from "@napi-rs/canvas";
import { Effect } from "effect";

// Create a 200x200 canvas
const canvas = createCanvas(200, 200);
const ctx = canvas.getContext("2d");

// Fill background with white
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 200, 200);

// Draw a red circle in the center
ctx.fillStyle = "red";
ctx.beginPath();
ctx.arc(100, 100, 50, 0, Math.PI * 2);
ctx.fill();

// Save the image
const buffer = canvas.toBuffer("image/png");
const outputPath = `${import.meta.dir}/../test/data/red-circle.png`;

await Effect.runPromise(
	Effect.tryPromise({
		try: () => Bun.write(outputPath, buffer),
		catch: (error) => error,
	}),
);
console.log(`Generated test image at: ${outputPath}`);
