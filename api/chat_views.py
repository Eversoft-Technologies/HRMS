"""
REST API views for Chat module using Django ORM models.
"""
from rest_framework import status, permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from .models import ChatRoom, ChatMessage, ChatParticipant
from .serializers import ChatRoomSerializer, ChatMessageSerializer


@api_view(['GET', 'POST'])
@permission_classes([permissions.AllowAny])
def chat_rooms(request):
    """
    GET /api/chat/rooms?email=<email> — retrieve chat rooms for a user.
    POST /api/chat/rooms — create a new chat room.
    """
    if request.method == 'GET':
        email = request.query_params.get('email')
        if email:
            room_ids = ChatParticipant.objects.filter(email=email).values_list('room_id', flat=True)
            rooms = ChatRoom.objects.filter(id__in=room_ids)
        else:
            rooms = ChatRoom.objects.all()
        serializer = ChatRoomSerializer(rooms, many=True)
        return Response(serializer.data)

    elif request.method == 'POST':
        data = request.data
        name = data.get('name', 'General Room')
        room_type = data.get('type') or data.get('room_type') or 'direct'
        created_by = data.get('email') or data.get('created_by') or ''

        room = ChatRoom.objects.create(
            name=name,
            room_type=room_type,
            created_by=created_by
        )

        participants = data.get('participants') or []
        if created_by and created_by not in participants:
            participants.append(created_by)

        for p_email in participants:
            if p_email:
                ChatParticipant.objects.get_or_create(room=room, email=p_email)

        serializer = ChatRoomSerializer(room)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


@api_view(['GET', 'POST'])
@permission_classes([permissions.AllowAny])
def chat_messages(request, room_id):
    """
    GET /api/chat/rooms/<room_id>/messages — fetch messages.
    POST /api/chat/rooms/<room_id>/messages — send a message.
    """
    try:
        room = ChatRoom.objects.get(pk=room_id)
    except ChatRoom.DoesNotExist:
        return Response({'error': 'Room not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        messages = ChatMessage.objects.filter(room=room)
        serializer = ChatMessageSerializer(messages, many=True)
        return Response(serializer.data)

    elif request.method == 'POST':
        data = request.data
        sender_email = data.get('email') or data.get('sender_email') or ''
        content = data.get('content') or data.get('text') or ''

        if not sender_email:
            return Response({'error': 'sender_email is required'}, status=status.HTTP_400_BAD_REQUEST)

        msg = ChatMessage.objects.create(
            room=room,
            sender_email=sender_email,
            content=content,
            message_type=data.get('message_type', 'text')
        )
        serializer = ChatMessageSerializer(msg)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
