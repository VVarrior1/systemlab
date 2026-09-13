import type { Lesson } from "../types";
import { chapterTitles, type ChapterFile } from "./shared";
import { chapter as foundations } from "./chapters/01-foundations";
import { chapter as performance } from "./chapters/02-performance";
import { chapter as queues } from "./chapters/03-queues";
import { chapter as caching } from "./chapters/04-caching";
import { chapter as reliability } from "./chapters/05-reliability";
import { chapter as replication } from "./chapters/06-replication";
import { chapter as partitioning } from "./chapters/07-partitioning";
import { chapter as trafficControl } from "./chapters/08-traffic-control";
import { chapter as multiRegion } from "./chapters/09-multi-region";
import { chapter as dataSystems } from "./chapters/10-data-systems";
import { chapter as toolkit } from "./chapters/11-toolkit";
import { chapter as briefs } from "./chapters/12-briefs";
import { chapter as briefsSystems } from "./chapters/13-briefs-systems";
import { chapter as briefsProducts } from "./chapters/14-briefs-products";

const files: ChapterFile[] = [foundations, performance, queues, caching, reliability, replication, partitioning, trafficControl, multiRegion, dataSystems, toolkit, briefs, briefsSystems, briefsProducts];

export const chapters: string[] = [...chapterTitles];

export const lessons: Lesson[] = files.flatMap((file) => file.lessons.map((item) => ({ ...item, chapter: file.title }))).map((item, index) => ({ ...item, number: index + 1 }));

export function getLesson(id: string): Lesson | undefined {
  return lessons.find((item) => item.id === id);
}

export function chapterLessons(chapter: string): Lesson[] {
  return lessons.filter((item) => item.chapter === chapter);
}

export const difficulties: Lesson["difficulty"][] = ["Beginner", "Intermediate", "Advanced", "Expert"];
