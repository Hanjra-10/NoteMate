import { prisma } from '../lib/prisma.js';

export async function getSubjects(req, res) {
  const subjects = await prisma.subject.findMany({
    where: { userId: req.user.id },
    include: { _count: { select: { sessions: true } } },
    orderBy: { updatedAt: 'desc' }
  });
  res.json({ success: true, data: subjects });
}

export async function createSubject(req, res) {
  const { name } = req.body;
  const subject = await prisma.subject.create({
    data: { name, userId: req.user.id }
  });
  res.status(201).json({ success: true, data: subject });
}

export async function deleteSubject(req, res) {
  const { subjectId } = req.params;
  
  // Verify ownership
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId, userId: req.user.id }
  });

  if (!subject) {
    return res.status(404).json({ error: "Subject not found or access denied" });
  }

  await prisma.subject.delete({ where: { id: subjectId } });
  res.json({ success: true, message: "Subject deleted" });
}