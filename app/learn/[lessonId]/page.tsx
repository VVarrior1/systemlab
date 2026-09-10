import { notFound } from "next/navigation";
import { lessons, getLesson } from "@/lib/curriculum";
import { Playground } from "@/components/playground";
import { Suspense } from "react";
export function generateStaticParams() { return lessons.map((lesson) => ({ lessonId: lesson.id })); }
export async function generateMetadata({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  return { title: getLesson(lessonId)?.title ?? "Lesson" };
}
export default async function LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  const lesson = getLesson(lessonId);
  if (!lesson) notFound();
  return <Suspense fallback={<div className="page-loading">Opening workspace...</div>}><Playground key={lesson.id} lesson={lesson} /></Suspense>;
}
