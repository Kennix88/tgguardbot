import { createCanvas } from "@napi-rs/canvas";

/**
 * Картиночная капча.
 *
 * Ключевая идея: правильный ответ виден ТОЛЬКО из пикселей картинки.
 * Кнопки подписаны нейтральными буквами (A/B/C/D), которые никак
 * не связаны текстово с заданием в сообщении. Это ломает любой бот,
 * который решает капчу string-match'ем текста вопроса и текста кнопок
 * (а таких — подавляющее большинство спам-ботов в TG).
 *
 * Против vision-LLM это не панацея, но в связке с шумом/поворотами
 * и тайминг-эвристикой (см. captcha.ts) поднимает стоимость атаки.
 */

const COLORS = [
    { name: "красный", hex: "#e63946" },
    { name: "зелёный", hex: "#2a9d8f" },
    { name: "синий", hex: "#457b9d" },
    { name: "оранжевый", hex: "#f4a261" },
    { name: "фиолетовый", hex: "#8e44ad" },
    { name: "жёлтый", hex: "#e9c46a" },
] as const;

const SHAPES = ["circle", "square", "triangle", "star"] as const;
type Shape = (typeof SHAPES)[number];

const LABELS = ["A", "B", "C", "D", "E", "F"];

export interface ImageCaptcha {
    imageBuffer: Buffer;
    /** Текст задания на естественном языке ("нажмите на синий квадрат") */
    promptText: string;
    /** Индекс правильной кнопки в options (0-based) */
    correctIndex: number;
    /** Нейтральные подписи кнопок в порядке отображения на картинке */
    optionLabels: string[];
}

function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function drawShape(
    ctx: import("@napi-rs/canvas").SKRSContext2D,
    shape: Shape,
    cx: number,
    cy: number,
    size: number,
    color: string,
    rotationDeg: number,
) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;

    switch (shape) {
        case "circle":
            ctx.beginPath();
            ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            break;
        case "square":
            ctx.beginPath();
            ctx.rect(-size / 2, -size / 2, size, size);
            ctx.fill();
            ctx.stroke();
            break;
        case "triangle":
            ctx.beginPath();
            ctx.moveTo(0, -size / 2);
            ctx.lineTo(size / 2, size / 2);
            ctx.lineTo(-size / 2, size / 2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;
        case "star": {
            const spikes = 5;
            const outer = size / 2;
            const inner = size / 4;
            ctx.beginPath();
            for (let i = 0; i < spikes * 2; i++) {
                const r = i % 2 === 0 ? outer : inner;
                const a = (Math.PI / spikes) * i - Math.PI / 2;
                const px = Math.cos(a) * r;
                const py = Math.sin(a) * r;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            break;
        }
    }
    ctx.restore();
}

function drawNoise(
    ctx: import("@napi-rs/canvas").SKRSContext2D,
    w: number,
    h: number,
) {
    // Отвлекающие линии/точки — усложняет чистый OCR/контур-детект
    for (let i = 0; i < 18; i++) {
        ctx.strokeStyle = `rgba(0,0,0,${rand(0.04, 0.12)})`;
        ctx.lineWidth = rand(1, 2);
        ctx.beginPath();
        ctx.moveTo(rand(0, w), rand(0, h));
        ctx.lineTo(rand(0, w), rand(0, h));
        ctx.stroke();
    }
    for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(0,0,0,${rand(0.03, 0.1)})`;
        ctx.beginPath();
        ctx.arc(rand(0, w), rand(0, h), rand(1, 2.5), 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * Генерирует картинку с N фигурами в случайных позициях, каждая подписана
 * нейтральной буквой. Задание в тексте называет цвет+форму, которую нужно
 * найти на картинке и нажать соответствующую кнопку-букву.
 */
export function generateImageCaptcha(optionCount = 4): ImageCaptcha {
    const width = 480;
    const height = 220;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // фон
    ctx.fillStyle = "#f1f1f1";
    ctx.fillRect(0, 0, width, height);
    drawNoise(ctx, width, height);

    const count = Math.min(optionCount, LABELS.length);
    const labels = LABELS.slice(0, count);

    // случайные уникальные комбинации цвет+форма для каждой ячейки,
    // чтобы не было двух одинаковых фигур подряд (иначе задание неоднозначно)
    const combos = shuffle(
        COLORS.flatMap((c) => SHAPES.map((s) => ({ color: c, shape: s }))),
    ).slice(0, count);

    const targetIdx = Math.floor(Math.random() * count);
    const target = combos[targetIdx];

    const cellW = width / count;
    const order = shuffle(labels.map((_, i) => i)); // порядок отображения ячеек

    order.forEach((comboIdx, slot) => {
        const combo = combos[comboIdx];
        const cx = cellW * slot + cellW / 2 + rand(-10, 10);
        const cy = height / 2 - 10 + rand(-8, 8);
        const size = rand(52, 68);
        const rotation = rand(-20, 20);
        drawShape(ctx, combo.shape, cx, cy, size, combo.color.hex, rotation);

        // подпись-буква под фигурой
        ctx.fillStyle = "#1d1d1d";
        ctx.font = "bold 22px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(labels[slot], cx, height - 24);

        if (comboIdx === targetIdx) {
            // запоминаем, на каком слоте (не индексе комбо!) оказался таргет
        }
    });

    const correctSlot = order.indexOf(targetIdx);

    const shapeNames: Record<Shape, string> = {
        circle: "круг",
        square: "квадрат",
        triangle: "треугольник",
        star: "звезду",
    };
    const promptText = `Нажмите на кнопку под фигурой: ${target.color.name} ${shapeNames[target.shape]}`;

    return {
        imageBuffer: canvas.toBuffer("image/png"),
        promptText,
        correctIndex: correctSlot,
        optionLabels: labels,
    };
}
