import json
from datetime import datetime

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer

from .models import ChatMessage, ChatRoom


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_id = self.scope["url_route"]["kwargs"]["room_id"]
        self.room_group_name = f"chat_{self.room_id}"

        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name,
        )

        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name,
        )

    async def receive(self, text_data):
        data = json.loads(text_data)

        sender_email = data.get("sender_email")
        sender_name = data.get("sender_name")
        message = data.get("message")

        chat_message = await self.save_message(
            sender_email,
            sender_name,
            message,
        )

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                "type": "chat_message",
                "id": chat_message.id,
                "sender_email": chat_message.sender_email,
                "sender_name": chat_message.sender_name,
                "message": chat_message.message,
                "created_at": str(chat_message.created_at),
            },
        )

    async def chat_message(self, event):
        await self.send(
            text_data=json.dumps(
                {
                    "event": "message",
                    "id": event["id"],
                    "sender_email": event["sender_email"],
                    "sender_name": event["sender_name"],
                    "message": event["message"],
                    "created_at": event["created_at"],
                    "attachment_name": event.get("attachment_name"),
                    "attachment_type": event.get("attachment_type"),
                    "attachment_url": event.get("attachment_url"),
                    "reply_to_id": event.get("reply_to_id"),
                    "reply_to_sender": event.get("reply_to_sender"),
                    "reply_to_text": event.get("reply_to_text"),
                }
            )
        )

    async def message_pinned(self, event):
        await self.send(
            text_data=json.dumps(
                {
                    "event": "pinned",
                    "id": event["id"],
                    "is_pinned": event["is_pinned"],
                    "pinned_by": event.get("pinned_by", ""),
                    "pin_expires_at": event.get("pin_expires_at"),
                }
            )
        )

    async def message_edited(self, event):
        await self.send(
            text_data=json.dumps(
                {
                    "event": "edited",
                    "id": event["id"],
                    "message": event.get("message", ""),
                    "edited": True,
                    "edited_at": event.get("edited_at"),
                }
            )
        )

    async def message_deleted(self, event):
        await self.send(
            text_data=json.dumps({"event": "deleted", "id": event["id"]})
        )

    @sync_to_async
    def save_message(self, sender_email, sender_name, message):
        room = ChatRoom.objects.get(id=self.room_id)

        return ChatMessage.objects.create(
            room=room,
            sender_email=sender_email,
            sender_name=sender_name,
            message=message,
            created_at=datetime.now(),
            is_read=False,
        )

class EmployeeStatusConsumer(AsyncWebsocketConsumer):
    """Per-employee live channel for the F2F employee-detail popup.

    Server-to-client only: a viewer opens ws/employee/<email>/ and receives
    'task' and 'attendance' events pushed by post_save signals when that
    employee's tasks or attendance change (see api/signals_realtime.py).
    """

    async def connect(self):
        import re
        from urllib.parse import unquote
        raw = self.scope["url_route"]["kwargs"].get("email", "")
        self.email = unquote(raw).strip().lower()
        # Channel group names allow only [A-Za-z0-9._-]; the email's "@" is not
        # allowed, so map disallowed chars to "_". Must match signals_realtime.
        safe = re.sub(r"[^a-z0-9._-]", "_", self.email)
        self.group_name = ("emp_" + safe)[:95]
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if getattr(self, "group_name", None):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def task_update(self, event):
        await self.send(text_data=json.dumps({"event": "task", "task": event.get("data")}))

    async def attendance_update(self, event):
        await self.send(text_data=json.dumps({"event": "attendance", "data": event.get("data")}))

    async def submission_update(self, event):
        await self.send(text_data=json.dumps({"event": "submission", "data": event.get("data")}))

    async def leave_update(self, event):
        await self.send(text_data=json.dumps({"event": "leave", "data": event.get("data")}))
